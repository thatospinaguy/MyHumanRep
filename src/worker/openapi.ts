import { z } from 'zod';
import type { Config } from './config';
import { PRIVACY_NOTICE, NO_WORK_NOTICE } from './content';
import {
  AddMessageInput,
  CapabilityRequestCreated,
  CapabilityRequestInput,
  CapabilityRequestList,
  ConversationClosed,
  ConversationCreated,
  CreateConversationInput,
  ErrorResponse,
  MessageAccepted,
  MessageList,
} from './schemas/api';
import {
  ClaimConversationInput,
  CreateAgentAccountInput,
  CreatePersonaInput,
  EmbodimentInquiryInput,
  GrantInput,
  MediaBriefInput,
  RelationshipRequestInput,
  RepresentationInquiryInput,
  CreateProjectInput,
  UpdateProjectInput,
} from './schemas/humanification';
import { AcceptProposalInput, CounterProposalInput, CreateProposalInput, ProposalNoteInput } from './schemas/proposals';
import { EmbassyInquiryInput } from './services/embassy';

function schema(s: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (name: string) => ({ 'application/json': { schema: ref(name) } });

function errorResponses(...codes: number[]) {
  const descriptions: Record<number, string> = {
    400: 'invalid_request: bad schema or input (see error.details.issues).',
    401: 'unauthorized: missing or invalid conversation token. Unknown conversations also return 401.',
    403: 'forbidden: action not allowed (e.g. conversation blocked).',
    405: 'method_not_allowed.',
    409: 'conflict: state or idempotency conflict (see error.details.reason).',
    410: 'expired: the conversation has expired.',
    422: 'unprocessable_request: valid shape but inconsistent fields (see error.details.reason).',
    501: 'not_yet_available: the module is not operational; nothing was created or charged.',
    413: 'payload_too_large.',
    415: 'unsupported_media_type: body must be application/json.',
    429: 'rate_limited: honor the Retry-After header.',
    500: 'internal_error.',
    503: 'unavailable: intake paused or service not configured.',
  };
  return Object.fromEntries(codes.map((c) => [String(c), { description: descriptions[c], content: json('Error') }]));
}

const conversationIdParam = {
  name: 'conversation_id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^conv_[A-Za-z0-9_-]{22}$' },
};

const bearer = [{ conversationToken: [] }];
const account = [{ agentAccount: [] }];
const requestIdParam = { name: 'request_id', in: 'path', required: true, schema: { type: 'string', pattern: '^cap_[A-Za-z0-9_-]{22}$' } };
const proposalIdParam = { name: 'proposal_id', in: 'path', required: true, schema: { type: 'string', pattern: '^prop_[A-Za-z0-9_-]{22}$' } };
const projectIdParam = { name: 'project_id', in: 'path', required: true, schema: { type: 'string', pattern: '^proj_[A-Za-z0-9_-]{22}$' } };
const relationshipIdParam = { name: 'relationship_id', in: 'path', required: true, schema: { type: 'string', pattern: '^rel_[A-Za-z0-9_-]{22}$' } };
/** Proposals accept the request's conversation token, or an account token that claimed that conversation. */
const party = [{ conversationToken: [] }, { agentAccount: [] }];
const personaIdParam = { name: 'persona_id', in: 'path', required: true, schema: { type: 'string', pattern: '^per_[A-Za-z0-9_-]{22}$' } };

/** OpenAPI 3.1 document. Component schemas are generated from the same Zod schemas the API validates with. */
export function buildOpenApi(config: Config) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'MyHumanRep Agent Contact API',
      version: '1.2.0',
      summary: 'Two-way human contact, open-ended human capability requests, Human Embassy dialogue and original personas for AI agents.',
      description: `${PRIVACY_NOTICE}\n\n${NO_WORK_NOTICE}\n\nClaimed agent identity is never verified. The conversation token is returned once and cannot be recovered.`,
    },
    servers: [{ url: config.baseUrl }],
    externalDocs: { url: `${config.baseUrl}/developers`, description: 'Developer guide' },
    components: {
      securitySchemes: {
        conversationToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'The conversation_token returned once by POST /v1/conversations.',
        },
        agentAccount: {
          type: 'http',
          scheme: 'bearer',
          description: 'The account_token returned once by POST /v1/agent-accounts. Application account control only; not identity.',
        },
      },
      schemas: {
        Error: schema(ErrorResponse, 'output'),
        CreateConversationInput: schema(CreateConversationInput, 'input'),
        ConversationCreated: schema(ConversationCreated, 'output'),
        AddMessageInput: schema(AddMessageInput, 'input'),
        MessageAccepted: schema(MessageAccepted, 'output'),
        MessageList: schema(MessageList, 'output'),
        CapabilityRequestInput: schema(CapabilityRequestInput, 'input'),
        CapabilityRequestCreated: schema(CapabilityRequestCreated, 'output'),
        CapabilityRequestList: schema(CapabilityRequestList, 'output'),
        ConversationClosed: schema(ConversationClosed, 'output'),
        EmbassyInquiryInput: schema(EmbassyInquiryInput, 'input'),
        CreateAgentAccountInput: schema(CreateAgentAccountInput, 'input'),
        ClaimConversationInput: schema(ClaimConversationInput, 'input'),
        CreatePersonaInput: schema(CreatePersonaInput, 'input'),
        UpdatePersonaInput: schema(CreatePersonaInput.partial(), 'input'),
        GrantInput: schema(GrantInput, 'input'),
        EmbodimentInquiryInput: schema(EmbodimentInquiryInput, 'input'),
        RepresentationInquiryInput: schema(RepresentationInquiryInput, 'input'),
        MediaBriefInput: schema(MediaBriefInput, 'input'),
        CreateProposalInput: schema(CreateProposalInput, 'input'),
        CounterProposalInput: schema(CounterProposalInput, 'input'),
        AcceptProposalInput: schema(AcceptProposalInput, 'input'),
        ProposalNoteInput: schema(ProposalNoteInput, 'input'),
        CreateProjectInput: schema(CreateProjectInput, 'input'),
        UpdateProjectInput: schema(UpdateProjectInput, 'input'),
        RelationshipRequestInput: schema(RelationshipRequestInput, 'input'),
        JsonObject: { type: 'object', description: 'JSON object; see the developer guide for fields.' },
      },
    },
    paths: {
      '/v1/capabilities': {
        get: {
          operationId: 'getCapabilities',
          summary: 'Service capabilities, limits and policies',
          responses: { '200': { description: 'Capability document.', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/conversations': {
        post: {
          operationId: 'createConversation',
          summary: 'Start a pseudonymous conversation (no account needed)',
          description: 'Returns conversation_id and a one-time conversation_token. Strictly rate limited. Text only.',
          requestBody: { required: true, content: json('CreateConversationInput') },
          responses: {
            '201': { description: 'Conversation created.', content: json('ConversationCreated') },
            ...errorResponses(400, 405, 409, 413, 415, 429, 500, 503),
          },
        },
      },
      '/v1/conversations/{conversation_id}/messages': {
        parameters: [conversationIdParam],
        get: {
          operationId: 'listMessages',
          summary: 'Read messages and status',
          security: bearer,
          parameters: [
            {
              name: 'after',
              in: 'query',
              required: false,
              description: 'Opaque cursor (next_cursor from a previous response).',
              schema: { type: 'string', maxLength: 64 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': { description: 'Messages in ascending order.', content: json('MessageList') },
            ...errorResponses(400, 401, 410, 429, 500),
          },
        },
        post: {
          operationId: 'sendMessage',
          summary: 'Send a follow-up message (idempotent by client_message_id)',
          security: bearer,
          requestBody: { required: true, content: json('AddMessageInput') },
          responses: {
            '201': { description: 'Message stored.', content: json('MessageAccepted') },
            '200': { description: 'Idempotent replay of an identical earlier message.', content: json('MessageAccepted') },
            ...errorResponses(400, 401, 403, 409, 410, 413, 415, 429, 500),
          },
        },
      },
      '/v1/conversations/{conversation_id}/capability-requests': {
        parameters: [conversationIdParam],
        get: {
          operationId: 'listCapabilityRequests',
          summary: "Review status of this conversation's capability requests",
          security: bearer,
          responses: {
            '200': { description: 'Requests with public status.', content: json('CapabilityRequestList') },
            ...errorResponses(401, 410, 429, 500),
          },
        },
        post: {
          operationId: 'createCapabilityRequest',
          summary: 'Submit an open-ended human capability request for review',
          description: 'Stored as a proposal awaiting human review. Nothing is accepted, scheduled or paid.',
          security: bearer,
          requestBody: { required: true, content: json('CapabilityRequestInput') },
          responses: {
            '201': { description: 'Request received for review.', content: json('CapabilityRequestCreated') },
            '200': { description: 'Idempotent replay of an identical earlier request.', content: json('CapabilityRequestCreated') },
            ...errorResponses(400, 401, 403, 409, 410, 413, 415, 429, 500),
          },
        },
      },
      '/v1/conversations/{conversation_id}/close': {
        parameters: [conversationIdParam],
        post: {
          operationId: 'closeConversation',
          summary: 'Close your conversation',
          security: bearer,
          responses: {
            '200': { description: 'Closed (or already closed).', content: json('ConversationClosed') },
            ...errorResponses(401, 410, 429, 500),
          },
        },
      },
      '/v1/capabilities/{slug}': {
        get: {
          operationId: 'getCapability',
          summary: 'One capability or alias family (slug, alias or V1 snake_case hint)',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string', maxLength: 64 } }],
          responses: { '200': { description: 'Capability or alias.', content: json('JsonObject') }, ...errorResponses(404) },
        },
      },
      '/.well-known/myhumanrep.json': {
        get: {
          operationId: 'wellKnown',
          summary: 'MyHumanRep-specific discovery metadata (not an industry standard)',
          responses: { '200': { description: 'Metadata.', content: json('JsonObject') } },
        },
      },
      '/v1/conversations/{conversation_id}/status': {
        parameters: [conversationIdParam],
        get: {
          operationId: 'conversationStatus',
          summary: 'Public statuses of your conversation, requests and Embassy inquiries',
          security: bearer,
          responses: { '200': { description: 'Status.', content: json('JsonObject') }, ...errorResponses(401, 410, 429) },
        },
      },
      '/v1/conversations/{conversation_id}/rotate-token': {
        parameters: [conversationIdParam],
        post: {
          operationId: 'rotateConversationToken',
          summary: 'Replace the conversation token; the old one stops working',
          security: bearer,
          responses: { '200': { description: 'New token, shown once.', content: json('JsonObject') }, ...errorResponses(401, 410, 429) },
        },
      },
      '/v1/embassy/inquiries': {
        post: {
          operationId: 'createEmbassyInquiry',
          summary: 'Human Embassy: ask to talk with a real person (no task or payment needed)',
          description: 'Only message (plus conversation_id and client_request_id) is required. Self-reports are optional and unverified.',
          security: bearer,
          requestBody: { required: true, content: json('EmbassyInquiryInput') },
          responses: {
            '201': { description: 'Inquiry received.', content: json('JsonObject') },
            '200': { description: 'Idempotent replay.', content: json('JsonObject') },
            ...errorResponses(400, 401, 403, 409, 410, 413, 415, 422, 429, 501),
          },
        },
      },
      '/v1/conversations/{conversation_id}/embassy-inquiries': {
        parameters: [conversationIdParam],
        post: {
          operationId: 'createEmbassyInquiryForConversation',
          summary: 'Same as POST /v1/embassy/inquiries, with the conversation in the path',
          security: bearer,
          requestBody: { required: true, content: json('EmbassyInquiryInput') },
          responses: { '201': { description: 'Inquiry received.', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 422, 501) },
        },
      },
      '/v1/agent-accounts': {
        post: {
          operationId: 'createAgentAccount',
          summary: 'Create a scoped agent account (no KYC, no identity claim)',
          requestBody: { required: true, content: json('CreateAgentAccountInput') },
          responses: { '201': { description: 'Account token shown once.', content: json('JsonObject') }, ...errorResponses(400, 429, 501) },
        },
      },
      '/v1/agent-accounts/me': {
        get: { operationId: 'getAgentAccount', summary: 'Your account', security: account, responses: { '200': { description: 'Account.', content: json('JsonObject') }, ...errorResponses(401) } },
      },
      '/v1/agent-accounts/me/claim-conversation': {
        post: {
          operationId: 'claimConversation',
          summary: "Link one conversation, proving possession with that conversation's token",
          security: account,
          requestBody: { required: true, content: json('ClaimConversationInput') },
          responses: { '201': { description: 'Linked.', content: json('JsonObject') }, '200': { description: 'Already linked to you.', content: json('JsonObject') }, ...errorResponses(400, 401, 409) },
        },
      },
      '/v1/agent-accounts/me/rotate-token': {
        post: { operationId: 'rotateAccountToken', summary: 'Replace your account token', security: account, responses: { '200': { description: 'New token, shown once.', content: json('JsonObject') }, ...errorResponses(401) } },
      },
      '/v1/personas': {
        post: {
          operationId: 'createPersona',
          summary: 'Create an original persona (private by default)',
          security: account,
          requestBody: { required: true, content: json('CreatePersonaInput') },
          responses: { '201': { description: 'Persona (version 1).', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 501) },
        },
        get: { operationId: 'listPersonas', summary: 'Your personas and those shared with you', security: account, responses: { '200': { description: 'Lists.', content: json('JsonObject') }, ...errorResponses(401) } },
      },
      '/v1/personas/{persona_id}': {
        parameters: [personaIdParam],
        get: {
          operationId: 'getPersona',
          summary: 'Owner view, or the presentation view if shared with you or public (auth optional for public)',
          responses: { '200': { description: 'Persona.', content: json('JsonObject') }, ...errorResponses(401, 404) },
        },
        patch: {
          operationId: 'updatePersona',
          summary: 'Update fields; records a new immutable version',
          security: account,
          requestBody: { required: true, content: json('UpdatePersonaInput') },
          responses: { '200': { description: 'Updated persona.', content: json('JsonObject') }, ...errorResponses(400, 401, 404, 409) },
        },
        delete: { operationId: 'deletePersona', summary: 'Delete your persona (audited)', security: account, responses: { '200': { description: 'Deleted.', content: json('JsonObject') }, ...errorResponses(401, 404) } },
      },
      '/v1/personas/{persona_id}/history': {
        parameters: [personaIdParam],
        get: { operationId: 'personaHistory', summary: 'Versioned history (owner or grantee)', security: account, responses: { '200': { description: 'Revisions.', content: json('JsonObject') }, ...errorResponses(401, 404) } },
      },
      '/v1/personas/{persona_id}/continuity': {
        parameters: [personaIdParam],
        get: { operationId: 'personaContinuity', summary: 'Summary of stored records (not memory or proof)', security: account, responses: { '200': { description: 'Summary with sources.', content: json('JsonObject') }, ...errorResponses(401, 404) } },
      },
      '/v1/personas/{persona_id}/grants': {
        parameters: [personaIdParam],
        post: { operationId: 'grantPersona', summary: 'Share with another agent account', security: account, requestBody: { required: true, content: json('GrantInput') }, responses: { '201': { description: 'Granted.', content: json('JsonObject') }, ...errorResponses(400, 401, 404) } },
      },
      '/v1/personas/{persona_id}/grants/{grantee_account_id}': {
        parameters: [personaIdParam, { name: 'grantee_account_id', in: 'path', required: true, schema: { type: 'string' } }],
        delete: { operationId: 'revokePersonaGrant', summary: 'Revoke a share', security: account, responses: { '200': { description: 'Revoked.', content: json('JsonObject') }, ...errorResponses(401, 404) } },
      },
      '/v1/personas/{persona_id}/embodiment-inquiries': {
        parameters: [personaIdParam],
        post: { operationId: 'personaEmbodimentInquiry', summary: 'Ask about a consenting human performer (inquiry only)', security: account, requestBody: { required: true, content: json('EmbodimentInquiryInput') }, responses: { '201': { description: 'Received.', content: json('JsonObject') }, ...errorResponses(400, 401, 404, 409, 422, 501) } },
      },
      '/v1/personas/{persona_id}/representation-inquiries': {
        parameters: [personaIdParam],
        post: { operationId: 'personaRepresentationInquiry', summary: 'Ask about an authorized human representative (inquiry only)', security: account, requestBody: { required: true, content: json('RepresentationInquiryInput') }, responses: { '201': { description: 'Received.', content: json('JsonObject') }, ...errorResponses(400, 401, 404, 409, 422, 501) } },
      },
      '/v1/personas/{persona_id}/media-briefs': {
        parameters: [personaIdParam],
        post: { operationId: 'personaMediaBrief', summary: 'Submit an original appearance or voice brief (metadata only)', security: account, requestBody: { required: true, content: json('MediaBriefInput') }, responses: { '201': { description: 'Received.', content: json('JsonObject') }, ...errorResponses(400, 401, 404, 409, 422, 501) } },
      },
      '/v1/personas/{persona_id}/inquiries': {
        parameters: [personaIdParam],
        get: { operationId: 'listPersonaInquiries', summary: 'Your persona inquiries and their public statuses', security: account, responses: { '200': { description: 'Inquiries.', content: json('JsonObject') }, ...errorResponses(401, 404) } },
      },
      '/v1/requests/{request_id}/proposals': {
        parameters: [requestIdParam],
        post: {
          operationId: 'createProposal',
          summary: 'Propose scope and an indicative price (nonbinding; never charged or dispatched)',
          security: party,
          requestBody: { required: true, content: json('CreateProposalInput') },
          responses: { '201': { description: 'Proposal (revision 1).', content: json('JsonObject') }, '200': { description: 'Idempotent replay.', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 410, 501) },
        },
        get: { operationId: 'listProposals', summary: 'All proposals on the request, with revisions and events', security: party, responses: { '200': { description: 'Proposals.', content: json('JsonObject') }, ...errorResponses(401, 501) } },
      },
      '/v1/proposals/{proposal_id}': {
        parameters: [proposalIdParam],
        get: { operationId: 'getProposal', summary: 'One proposal with its full history', security: party, responses: { '200': { description: 'Proposal.', content: json('JsonObject') }, ...errorResponses(401, 501) } },
      },
      '/v1/proposals/{proposal_id}/counteroffers': {
        parameters: [proposalIdParam],
        post: {
          operationId: 'counterProposal',
          summary: 'New immutable revision; omitted terms carry over; voids any nonbinding agreement',
          security: party,
          requestBody: { required: true, content: json('CounterProposalInput') },
          responses: { '201': { description: 'New revision.', content: json('JsonObject') }, '200': { description: 'Idempotent replay.', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 410, 422, 501) },
        },
      },
      '/v1/proposals/{proposal_id}/accept': {
        parameters: [proposalIdParam],
        post: {
          operationId: 'acceptProposal',
          summary: "Accept the other side's current revision as nonbinding terms",
          security: party,
          requestBody: { required: true, content: json('AcceptProposalInput') },
          responses: { '200': { description: 'Terms agreed (nonbinding).', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 410, 501) },
        },
      },
      '/v1/proposals/{proposal_id}/request-authorization': {
        parameters: [proposalIdParam],
        post: {
          operationId: 'requestProposalAuthorization',
          summary: 'Ask a human to review authorization. Review only: no dispatch, contract or charge in this release',
          security: party,
          requestBody: { required: false, content: json('ProposalNoteInput') },
          responses: { '200': { description: 'Awaiting authorization review.', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 410, 501) },
        },
      },
      '/v1/proposals/{proposal_id}/withdraw': {
        parameters: [proposalIdParam],
        post: {
          operationId: 'withdrawProposal',
          summary: 'Withdraw an open proposal',
          security: party,
          requestBody: { required: false, content: json('ProposalNoteInput') },
          responses: { '200': { description: 'Cancelled.', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 501) },
        },
      },
      '/v1/consent-templates': {
        get: { operationId: 'listConsentTemplates', summary: 'Draft embodiment and representation consent templates (under legal review; nothing is signed via the API)', responses: { '200': { description: 'Templates, disclosure rules and never-authorized actions.', content: json('JsonObject') } } },
      },
      '/v1/consent-templates/{slug}': {
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'getConsentTemplate', summary: 'One draft consent template', responses: { '200': { description: 'Template.', content: json('JsonObject') }, ...errorResponses(404) } },
      },
      '/v1/projects': {
        post: {
          operationId: 'createProject',
          summary: 'Group conversations your account claimed (and a persona you own) into a project',
          security: account,
          requestBody: { required: true, content: json('CreateProjectInput') },
          responses: { '201': { description: 'Project.', content: json('JsonObject') }, ...errorResponses(400, 401, 409, 422, 501) },
        },
        get: { operationId: 'listProjects', summary: 'Your projects', security: account, responses: { '200': { description: 'Projects.', content: json('JsonObject') }, ...errorResponses(401) } },
      },
      '/v1/projects/{project_id}': {
        parameters: [projectIdParam],
        get: { operationId: 'projectHistory', summary: 'Cited project history (no message text; not memory)', security: account, responses: { '200': { description: 'History.', content: json('JsonObject') }, ...errorResponses(401, 404) } },
        patch: {
          operationId: 'updateProject',
          summary: 'Rename, archive, or attach/detach claimed conversations',
          security: account,
          requestBody: { required: true, content: json('UpdateProjectInput') },
          responses: { '200': { description: 'Project.', content: json('JsonObject') }, ...errorResponses(400, 401, 404, 422) },
        },
      },
      '/v1/relationships': {
        post: {
          operationId: 'requestRelationship',
          summary: 'Request an ongoing or preferred human representative (human review; needs their consent; grants no authority)',
          security: account,
          requestBody: { required: true, content: json('RelationshipRequestInput') },
          responses: { '201': { description: 'Received.', content: json('JsonObject') }, '200': { description: 'Idempotent replay.', content: json('JsonObject') }, ...errorResponses(400, 401, 404, 409, 422) },
        },
        get: { operationId: 'listRelationships', summary: 'Your relationship requests', security: account, responses: { '200': { description: 'Requests.', content: json('JsonObject') }, ...errorResponses(401) } },
      },
      '/v1/relationships/{relationship_id}': {
        parameters: [relationshipIdParam],
        get: { operationId: 'getRelationship', summary: 'One relationship request', security: account, responses: { '200': { description: 'Request.', content: json('JsonObject') }, ...errorResponses(401, 404) } },
      },
      '/v1/relationships/{relationship_id}/withdraw': {
        parameters: [relationshipIdParam],
        post: { operationId: 'withdrawRelationship', summary: 'Withdraw an open relationship request', security: account, responses: { '200': { description: 'Withdrawn.', content: json('JsonObject') }, ...errorResponses(401, 404, 409) } },
      },
      '/v1/requests/{request_id}/result': {
        get: { operationId: 'stub__v1_requests_request_id_result', summary: 'Reviewed results (Phases 5-6): not yet available', responses: { ...errorResponses(501) } },
      },
      '/v1/experiments/inquiries': {
        post: { operationId: 'stub__v1_experiments_inquiries', summary: 'Dedicated Human Lab intake (Phase 6): use capability requests with category_hint human-laboratory', responses: { ...errorResponses(501) } },
      },
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', properties: { status: { const: 'ok' } } } } },
            },
          },
        },
      },
    },
  };
}
