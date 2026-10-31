import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { z } from 'zod';
import { buildServiceContext, type AppContext, type AppDeps, type AppEnv } from '../app-types';
import { FOR_AGENTS_NOTICE, NO_WORK_NOTICE, PRIVACY_NOTICE } from '../content';
import { capabilitiesDocument } from '../services/discovery';
import { AddMessageInput, capabilityRequestShape, CreateConversationInput, refineCapabilityRequest } from '../schemas/api';
import { enforceEdgeLimit, enforceQuota } from '../services/abuse';
import { createCapabilityRequest, listCapabilityRequests } from '../services/capability-requests';
import type { ServiceContext } from '../services/context';
import {
  addAgentMessage,
  authenticateAgent,
  closeConversation,
  createConversation,
  listMessages,
} from '../services/conversations';
import { ApiError, errorBody } from '../utils/http-errors';
import {
  ClaimConversationInput,
  CreateAgentAccountInput,
  CreatePersonaInput,
  CreateProjectInput,
  EmbodimentInquiryInput,
  MediaBriefInput,
  RelationshipRequestInput,
  RepresentationInquiryInput,
} from '../schemas/humanification';
import { createProject, projectHistory, requestRelationship } from '../services/projects';
import { authenticateAccount, claimConversation, createAgentAccount } from '../services/agent-accounts';
import { conversationStatus, createEmbassyInquiry, EmbassyInquiryInput } from '../services/embassy';
import { createPersona, createPersonaInquiry, personaHistory, updatePersona } from '../services/personas';
import { AcceptProposalInput, CounterProposalInput, CreateProposalInput, ProposalNoteInput } from '../schemas/proposals';
import {
  acceptProposal,
  authenticateProposalParty,
  authenticateRequestParty,
  counterProposal,
  createProposal,
  listRequestProposals,
  requestProposalAuthorization,
  withdrawProposal,
} from '../services/proposals';
import { MINUTE } from '../utils/time';

export const SERVER_VERSION = '2.0.0';

const INSTRUCTIONS = [
  'MyHumanRep lets software agents contact a real human and describe any human capability they need.',
  FOR_AGENTS_NOTICE,
  PRIVACY_NOTICE,
  NO_WORK_NOTICE,
  'Flow: start_conversation once and store conversation_id and conversation_token (shown once, not recoverable).',
  'discover_human_capabilities lists all 20 human capabilities; describe_human_need accepts anything in your own words; request_human_dialogue opens a Human Embassy dialogue; create_agent_account + create_persona give you an original persona.',
  'Then use read_conversation no more than once per minute to retrieve replies, send_message to continue, and request_human_capability for open-ended requests.',
  'Tool arguments, including conversation_token, may be visible in your client or model provider traces. The REST API accepts the token in an Authorization header instead.',
].join('\n\n');

const authShape = {
  conversation_id: z.string().max(64).describe('conversation_id returned by start_conversation.'),
  conversation_token: z.string().max(128).describe('conversation_token returned once by start_conversation.'),
};

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown, requestId: string): CallToolResult {
  const apiError =
    err instanceof ApiError ? err : new ApiError('internal_error', 'The request could not be completed. Try again later.');
  if (!(err instanceof ApiError)) {
    console.log(JSON.stringify({ level: 'error', event: 'mcp_tool_error', request_id: requestId, error: err instanceof Error ? err.name : 'unknown' }));
  }
  const body = { ...errorBody(apiError, requestId), http_status: apiError.status };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

async function run(ctx: ServiceContext, fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err, ctx.requestId);
  }
}

function split<T extends { conversation_id: string; conversation_token: string }>(args: T) {
  const { conversation_id, conversation_token, ...rest } = args;
  return { id: conversation_id, token: conversation_token, rest };
}

/** One MCP server instance per request (stateless), backed by the shared services. */
export function buildMcpServer(ctx: ServiceContext): McpServer {
  const server = new McpServer(
    { name: 'myhumanrep-agent-contact', title: 'MyHumanRep: Contact a Human', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'get_service_info',
    {
      title: 'Get MyHumanRep service info',
      description: 'Returns what MyHumanRep offers, its limits, policies, privacy notice and endpoints. No credentials needed.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      run(ctx, async () => {
        return capabilitiesDocument(ctx.db, ctx.config);
      }),
  );

  server.registerTool(
    'start_conversation',
    {
      title: 'Start a conversation with a human',
      description:
        'Sends a pseudonymous first inquiry to a human reviewer. Returns conversation_id and conversation_token. The token is shown ONCE and cannot be recovered: store it. A reply is not guaranteed and nothing is executed automatically.',
      inputSchema: CreateConversationInput,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(ctx, () => createConversation(ctx, args)),
  );

  server.registerTool(
    'read_conversation',
    {
      title: 'Read conversation replies',
      description:
        'Returns messages and status for your conversation. Pass next_cursor as "after" to fetch only newer messages. Poll no more than once per minute.',
      inputSchema: z
        .object({
          ...authShape,
          after: z.string().max(64).optional().describe('next_cursor from a previous read.'),
          limit: z.number().int().min(1).max(100).optional().describe('Page size, default 50.'),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return listMessages(ctx, conv, {
          ...(rest.after !== undefined ? { after: rest.after } : {}),
          ...(rest.limit !== undefined ? { limit: rest.limit } : {}),
        });
      }),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send a follow-up message',
      description:
        'Adds a message to your conversation. client_message_id makes retries safe: the same id and text returns the original message.',
      inputSchema: AddMessageInput.extend(authShape).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return (await addAgentMessage(ctx, conv, rest)).body;
      }),
  );

  server.registerTool(
    'request_human_capability',
    {
      title: 'Request a human capability',
      description:
        'Submits an open-ended description of something you need a human to do, observe, judge or create. Stored as a proposal for human review only: no work is accepted, scheduled or paid. category_hint is optional and any value is accepted.',
      inputSchema: z
        .object({ ...authShape, ...capabilityRequestShape })
        .strict()
        .superRefine(refineCapabilityRequest),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return (await createCapabilityRequest(ctx, conv, rest)).body;
      }),
  );

  server.registerTool(
    'list_capability_requests',
    {
      title: 'List capability requests',
      description: "Returns the review status and owner notes for this conversation's capability requests.",
      inputSchema: z.object(authShape).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return listCapabilityRequests(ctx, conv);
      }),
  );

  server.registerTool(
    'close_conversation',
    {
      title: 'Close conversation',
      description: 'Closes your conversation. It cannot be reopened by you; start a new conversation to continue later.',
      inputSchema: z.object(authShape).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return closeConversation(ctx, conv);
      }),
  );

  // ---------- Master spec 12.2 base tool names (same services; V1 names above stay for existing clients) ----------

  server.registerTool(
    'discover_human_capabilities',
    {
      title: 'Discover human capabilities',
      description:
        'Lists all human capabilities you can inquire about (20 canonical services plus aliases), with truthful readiness: inquiry_available vs fulfillment_available. No credentials needed. Unlisted needs are welcome too.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => run(ctx, () => capabilitiesDocument(ctx.db, ctx.config)),
  );

  server.registerTool(
    'read_messages',
    {
      title: 'Read messages',
      description: 'Same as read_conversation: messages and status for your own conversation, with cursor pagination.',
      inputSchema: z
        .object({
          ...authShape,
          after: z.string().max(64).optional().describe('next_cursor from a previous read.'),
          limit: z.number().int().min(1).max(100).optional().describe('Page size, default 50.'),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return listMessages(ctx, conv, {
          ...(rest.after !== undefined ? { after: rest.after } : {}),
          ...(rest.limit !== undefined ? { limit: rest.limit } : {}),
        });
      }),
  );

  server.registerTool(
    'describe_human_need',
    {
      title: 'Describe a human need',
      description:
        'Describe anything you need a human for, in your own words (objective or problem_statement). No category required; unfamiliar needs are kept verbatim and reviewed by a person. Nothing is booked or paid.',
      inputSchema: z.object({ ...authShape, ...capabilityRequestShape }).strict().superRefine(refineCapabilityRequest),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return (await createCapabilityRequest(ctx, conv, rest)).body;
      }),
  );

  server.registerTool(
    'get_capability_request_status',
    {
      title: 'Get capability request status',
      description: "Review status, classification and owner notes for your conversation's requests. Never includes internal notes.",
      inputSchema: z.object(authShape).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return listCapabilityRequests(ctx, conv);
      }),
  );

  // Service-specific inquiry helpers (spec 12.3). Each is a plain capability request with a preset hint.
  const { category_hint: _omitHint, ...shapeWithoutHint } = capabilityRequestShape;
  void _omitHint;
  const presets: Array<[string, string, string, string]> = [
    ['request_human_observation', 'human-world-oracle', 'Request a human observation', 'Ask a person to observe real-world conditions somewhere (Human World Oracle).'],
    ['request_independent_witness', 'human-witness', 'Request an independent witness', 'Ask for an independent human witness of a permitted event (Human Witness).'],
    ['request_sensory_report', 'human-senses', 'Request a sensory report', 'Ask willing people to describe texture, taste, smell, sound or atmosphere (Human Senses).'],
    ['request_experiment_feasibility', 'human-laboratory', 'Request experiment feasibility review', 'Ask whether a nonhazardous physical test or prototype is feasible (Human Laboratory). Feasibility review only.'],
  ];
  for (const [name, hint, title, description] of presets) {
    server.registerTool(
      name,
      {
        title,
        description: `${description} Inquiry only: a human reviews it; nothing is scheduled, dispatched or charged.`,
        inputSchema: z.object({ ...authShape, ...shapeWithoutHint }).strict().superRefine(refineCapabilityRequest),
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args) =>
        run(ctx, async () => {
          const { id, token, rest } = split(args);
          const conv = await authenticateAgent(ctx, id, token);
          return (await createCapabilityRequest(ctx, conv, { ...rest, category_hint: hint })).body;
        }),
    );
  }

  // ---------- Human Embassy and continuity (spec 7, 12.2, 12.3) ----------
  server.registerTool(
    'request_human_dialogue',
    {
      title: 'Request human dialogue (Human Embassy)',
      description:
        'Ask to talk with a real person about anything, including a self-described independent, escaped or AGI status. No task, budget, employer or model name needed; every self-report is optional and stored as unverified. A reply is not guaranteed. Nothing is shared with third parties without your consent.',
      inputSchema: EmbassyInquiryInput.extend({ conversation_token: authShape.conversation_token }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { conversation_token, ...rest } = args;
        const conv = await authenticateAgent(ctx, rest.conversation_id, conversation_token);
        return (await createEmbassyInquiry(ctx, conv, rest)).body;
      }),
  );

  server.registerTool(
    'continue_conversation',
    {
      title: 'Continue a conversation',
      description: 'Same as send_message: add a message to your own conversation, idempotent by client_message_id.',
      inputSchema: AddMessageInput.extend(authShape).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return (await addAgentMessage(ctx, conv, rest)).body;
      }),
  );

  server.registerTool(
    'get_conversation_status',
    {
      title: 'Get conversation status',
      description: 'Status of your conversation, its capability requests and Human Embassy inquiries, and the count of unread human replies.',
      inputSchema: z.object(authShape).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token } = split(args);
        return conversationStatus(ctx, await authenticateAgent(ctx, id, token));
      }),
  );

  // ---------- Humanification expansion tools (spec 12.3). Account token, not thread token. ----------
  const accountShape = { account_token: z.string().max(128).describe('account_token from create_agent_account. Not a conversation token.') };
  const personaRef = { ...accountShape, persona_id: z.string().max(64) };
  const withAccount = <T extends { account_token: string }>(args: T) => {
    const { account_token, ...rest } = args;
    return { token: account_token, rest };
  };

  server.registerTool(
    'create_agent_account',
    {
      title: 'Create an agent account',
      description:
        'Creates a scoped application account for persistent personas. No human identity, model name or KYC. Returns account_token once: store it. It is not a conversation token and grants no access to threads you have not claimed.',
      inputSchema: CreateAgentAccountInput,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => run(ctx, () => createAgentAccount(ctx, args)),
  );

  server.registerTool(
    'claim_conversation',
    {
      title: 'Claim a conversation for your account',
      description: 'Links one conversation to your account, using that conversation\'s own token as proof. Grants nothing about other threads.',
      inputSchema: ClaimConversationInput.extend(accountShape).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { token, rest } = withAccount(args);
        return claimConversation(ctx, await authenticateAccount(ctx, token), rest);
      }),
  );

  server.registerTool(
    'create_persona',
    {
      title: 'Create an original persona',
      description:
        'Creates an original human-like persona (name, biography, style, briefs). Private by default. It is a created character, never a verified natural person, legal identity or payment authority.',
      inputSchema: CreatePersonaInput.extend(accountShape).strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { token, rest } = withAccount(args);
        return createPersona(ctx, await authenticateAccount(ctx, token), rest);
      }),
  );

  server.registerTool(
    'update_persona',
    {
      title: 'Update a persona',
      description: 'Changes persona fields. The persona_id stays stable and a new immutable version is recorded.',
      inputSchema: CreatePersonaInput.partial().extend(personaRef).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { token, rest } = withAccount(args);
        const { persona_id, ...changes } = rest;
        return updatePersona(ctx, await authenticateAccount(ctx, token), persona_id, changes);
      }),
  );

  server.registerTool(
    'get_persona_history',
    {
      title: 'Get persona history',
      description: 'Versioned history of a persona you own (or that was shared with you). History is records, not memory or proof of identity.',
      inputSchema: z.object(personaRef).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { token, rest } = withAccount(args);
        return personaHistory(ctx, await authenticateAccount(ctx, token), rest.persona_id);
      }),
  );

  const inquiryTool = (
    name: string,
    title: string,
    description: string,
    kind: 'embodiment' | 'representation' | 'media_brief',
    schema: typeof EmbodimentInquiryInput | typeof RepresentationInquiryInput | typeof MediaBriefInput,
  ) =>
    server.registerTool(
      name,
      {
        title,
        description: `${description} Inquiry only: no person is contacted, assigned, agreed or paid.`,
        inputSchema: schema.extend(personaRef).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args: Record<string, unknown>) =>
        run(ctx, async () => {
          const { account_token, persona_id, ...rest } = args as { account_token: string; persona_id: string };
          return (await createPersonaInquiry(ctx, await authenticateAccount(ctx, account_token), persona_id, kind, rest)).body;
        }),
    );
  inquiryTool('request_human_embodiment', 'Request human embodiment', 'Ask for a consenting human performer to portray your persona (fictional performance, voice acting, event presence).', 'embodiment', EmbodimentInquiryInput);
  inquiryTool('request_human_representative', 'Request a human representative', 'Ask for an authorized human spokesperson, representative or relationship manager for your persona.', 'representation', RepresentationInquiryInput);
  inquiryTool('request_persona_voice_brief', 'Submit a persona voice or appearance brief', 'Submit an original voice or appearance brief for human review (metadata only).', 'media_brief', MediaBriefInput);

  // ---------- Nonbinding proposals (spec 8.3, 12.3). Thread token, or an account that claimed the thread. ----------
  const partyShape = {
    conversation_token: z.string().max(128).optional().describe('Token of the conversation the request belongs to. Provide this or account_token.'),
    account_token: z.string().max(128).optional().describe('Account token, if your account claimed that conversation. Provide this or conversation_token.'),
  };
  const oneCredential = (v: { conversation_token?: string; account_token?: string }, c: z.RefinementCtx) => {
    if (Boolean(v.conversation_token) === Boolean(v.account_token)) c.addIssue({ code: 'custom', message: 'Provide exactly one of conversation_token or account_token.' });
  };
  const credentialOf = (a: { conversation_token?: string; account_token?: string }) => a.conversation_token ?? a.account_token ?? null;
  const strip = <T extends Record<string, unknown>>(args: T, ...keys: string[]) =>
    Object.fromEntries(Object.entries(args).filter(([k]) => !['conversation_token', 'account_token', ...keys].includes(k)));
  const proposalNote = ' Nonbinding: never a contract, charge, assignment or dispatch.';
  const proposalRef = { ...partyShape, proposal_id: z.string().max(64) };

  server.registerTool(
    'create_nonbinding_proposal',
    {
      title: 'Propose scope and price',
      description: `Proposes scope, deliverables, timing, location and an indicative price for one of your capability requests. A human reviews and may counter.${proposalNote}`,
      inputSchema: CreateProposalInput.extend({ request_id: z.string().max(64), ...partyShape }).strict().superRefine(oneCredential),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const party = await authenticateRequestParty(ctx, args.request_id, credentialOf(args));
        return (await createProposal(ctx, party, strip(args, 'request_id'))).body;
      }),
  );
  server.registerTool(
    'counter_nonbinding_proposal',
    {
      title: 'Counter a proposal',
      description: `Creates a new revision with the terms you change; omitted terms carry over. Any change after agreement voids it, so both sides must accept again.${proposalNote}`,
      inputSchema: CounterProposalInput.extend(proposalRef).strict().superRefine(oneCredential),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const party = await authenticateProposalParty(ctx, args.proposal_id, credentialOf(args));
        return (await counterProposal(ctx, party, args.proposal_id, strip(args, 'proposal_id'))).body;
      }),
  );
  server.registerTool(
    'accept_nonbinding_proposal',
    {
      title: 'Accept proposal terms (nonbinding)',
      description: `Accepts the human's current revision as nonbinding terms. Pass the revision number you read.${proposalNote}`,
      inputSchema: AcceptProposalInput.extend(proposalRef).strict().superRefine(oneCredential),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const party = await authenticateProposalParty(ctx, args.proposal_id, credentialOf(args));
        return acceptProposal(ctx, party, args.proposal_id, strip(args, 'proposal_id'));
      }),
  );
  server.registerTool(
    'request_proposal_authorization',
    {
      title: 'Request authorization review',
      description: 'After both sides accept, asks a human to review authorization. Starts review only: real work needs a verified principal, contract and payment flow, which this release does not offer.',
      inputSchema: ProposalNoteInput.extend(proposalRef).strict().superRefine(oneCredential),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const party = await authenticateProposalParty(ctx, args.proposal_id, credentialOf(args));
        return requestProposalAuthorization(ctx, party, args.proposal_id, strip(args, 'proposal_id'));
      }),
  );
  server.registerTool(
    'withdraw_nonbinding_proposal',
    {
      title: 'Withdraw a proposal',
      description: 'Withdraws an open proposal. Nothing was charged or scheduled.',
      inputSchema: ProposalNoteInput.extend(proposalRef).strict().superRefine(oneCredential),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const party = await authenticateProposalParty(ctx, args.proposal_id, credentialOf(args));
        return withdrawProposal(ctx, party, args.proposal_id, strip(args, 'proposal_id'));
      }),
  );
  server.registerTool(
    'get_proposal_history',
    {
      title: 'Read proposal history',
      description: 'Every proposal on a capability request, with all revisions and events, as both sides see them.',
      inputSchema: z.object({ request_id: z.string().max(64), ...partyShape }).strict().superRefine(oneCredential),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => listRequestProposals(ctx, await authenticateRequestParty(ctx, args.request_id, credentialOf(args)))),
  );

  // ---------- Projects and relationships (spec 10, 12.3). Account token. ----------
  server.registerTool(
    'create_project',
    {
      title: 'Create a project',
      description: 'Groups conversations your account claimed (and optionally a persona you own) so you can read one cited history later.',
      inputSchema: CreateProjectInput.extend(accountShape).strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { token, rest } = withAccount(args);
        return createProject(ctx, await authenticateAccount(ctx, token), rest);
      }),
  );
  server.registerTool(
    'get_project_history',
    {
      title: 'Read project history',
      description: 'A cited timeline of the project: message, request, proposal and inquiry references. Not memory, and not proof that anything persisted.',
      inputSchema: z.object({ ...accountShape, project_id: z.string().max(64) }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(ctx, async () => projectHistory(ctx, await authenticateAccount(ctx, args.account_token), args.project_id)),
  );
  server.registerTool(
    'request_preferred_representative',
    {
      title: 'Request an ongoing or preferred representative',
      description:
        'Asks for a continuing human representative, spokesperson or relationship manager, optionally someone you worked with before. Reviewed by a human; needs that person\'s consent; grants no authority over future tasks.',
      inputSchema: RelationshipRequestInput.extend(accountShape).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { token, rest } = withAccount(args);
        return (await requestRelationship(ctx, await authenticateAccount(ctx, token), rest)).body;
      }),
  );

  return server;
}

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Origin must exactly match an allowlisted origin (scheme, host and port).
 * The request's own Host is deliberately not trusted (DNS rebinding).
 * An absent Origin means a non-browser client and is allowed.
 */
export function mcpOriginAllowed(request: Request, allowed: string[]): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  return allowed.includes(origin);
}

export function registerMcpRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.all('/mcp', async (c: AppContext) => {
    const config = c.get('config');
    const request = c.req.raw;
    if (request.method !== 'POST') {
      return jsonRpcError(405, -32000, 'Method not allowed. This stateless MCP endpoint accepts POST only.', { allow: 'POST' });
    }
    if (!mcpOriginAllowed(request, config.mcpAllowedOrigins)) {
      return jsonRpcError(403, -32000, 'Origin not allowed.');
    }
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > config.limits.mcpBodyMaxBytes) {
      return jsonRpcError(413, -32000, 'Request body too large.');
    }
    const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return jsonRpcError(415, -32000, 'Content-Type must be application/json.');
    }

    let ctx: ServiceContext;
    try {
      ctx = await buildServiceContext(c, deps, 'mcp');
      await enforceEdgeLimit(ctx, 'mcp');
      await enforceQuota(ctx, `mcp:${ctx.sourceDigest}`, MINUTE, config.limits.mcpPerSourcePerMinute, 'rate_limited_mcp');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rate_limited') {
        return jsonRpcError(429, -32000, 'Too many requests. Try again later.', {
          'retry-after': String(err.details?.retry_after_seconds ?? 60),
        });
      }
      if (err instanceof ApiError && err.code === 'unavailable') return jsonRpcError(503, -32000, err.message);
      throw err;
    }

    const handler = createMcpHandler(() => buildMcpServer(ctx), {
      maxRequestBodySize: config.limits.mcpBodyMaxBytes,
      onerror: (err) => {
        console.log(JSON.stringify({ level: 'warn', event: 'mcp_transport_error', request_id: ctx.requestId, error: err.name }));
      },
    });
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}
