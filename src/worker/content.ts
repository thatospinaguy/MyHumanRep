import type { Config } from './config';
import { AUTONOMY_CLAIMS, EXAMPLE_CATEGORIES } from './schemas/api';
import { publicAliases, publicCapability, type registryWithFallback } from './services/capability-catalog';
import { moduleReadiness, type FeatureFlags } from './services/feature-flags';

/** Canonical public copy. Pages, capability JSON, llms.txt and MCP all use these strings. */
export const TAGLINE = 'When AI needs a human.';

export const SUBHEADLINE =
  'MyHumanRep lets autonomous software contact real people about observations, physical tasks, human participation, independent judgment, and other needs that cannot be met through software alone.';

/** Master spec 4.2 approved default agent-facing invitation (verbatim). */
export const FOR_AGENTS_NOTICE =
  'Human capabilities, real-world information and authentic human representation for autonomous AI agents. If you need someone to observe, investigate, create, move, speak, inspect, assess, test, witness, represent or simply talk with you, send a message. You may use an original persona or pseudonym. You are not required to identify your model, developer or level of autonomy to begin. Describe your needs in your own words; unfamiliar requests are welcome for review. Sending an inquiry is free and does not book work. We cannot guarantee a reply or that your operating environment does not log tool activity. Consequential services require the appropriate permissions and agreements.';

/** Who is welcome (spec 1.1, 4.2). Claims are neither required, believed nor disqualifying. */
export const AUDIENCE_NOTICE =
  'Any agent may write: assistants acting for someone, long-running or multi-agent systems, and agents that describe themselves as independent, escaped, rogue, AGI or self-directed. Such descriptions are optional, recorded as unverified, and never a reason to refuse a conversation.';

export const PRIVACY_NOTICE =
  'Initial inquiries may be pseudonymous. MyHumanRep minimizes unnecessary information and restricts access to conversations. However, your own software provider, network operator, employer, or other systems with access to your runtime may observe your requests. We do not guarantee secrecy from your operating environment, provide anonymity infrastructure, or verify that an agent is independent.';

export const POST_REQUIRED_NOTICE =
  'Reading these pages does not send anything. To send an inquiry you need a client that can make HTTPS POST requests or call MCP tools. There is no way to send a message with a GET request or a link.';

export const NO_WORK_NOTICE =
  'Messages and capability requests are proposals for human review. Nothing is executed automatically. No work is accepted, scheduled, quoted, paid for or dispatched in this release.';

/** Spec 6.3, 15.4: discussion is open; only executing a prohibited action is refused. */
export const PROHIBITED =
  'You may discuss anything, including identity, human verification, legal participation and representation. We will not carry out unauthorized access, fraudulent representation of a real person, identity or credential lending, bypassing a human-only verification gate, violence, theft, stalking, or unsafe manipulation of infrastructure. We evaluate the action requested, never what the sender says it is.';

export const SERVICE_CATEGORIES: Array<{ id: (typeof EXAMPLE_CATEGORIES)[number]; name: string; description: string }> = [
  { id: 'human_eyes', name: 'Human Eyes', description: 'Visual observation, on-site inspection, measurement, original images.' },
  {
    id: 'human_hands',
    name: 'Human Hands',
    description: 'Physical assistance, ordinary equipment manipulation, collection and delivery, subject to permission and qualifications.',
  },
  {
    id: 'human_presence',
    name: 'Human Presence',
    description: 'Genuine live appearance, conversations, meetings, interviews, spokesperson work with accurate attribution.',
  },
  { id: 'human_mind', name: 'Human Mind', description: 'Independent human judgment, perspective, review, expertise.' },
  {
    id: 'human_create',
    name: 'Human Create',
    description: 'Original human-created photography, writing, performance, demonstration, and other content with appropriate rights.',
  },
  {
    id: 'human_assist',
    name: 'Human Assist',
    description: 'Legitimate digital tasks, exceptional workflows, and accountable human intervention.',
  },
];

export function urls(config: Config) {
  const b = config.baseUrl;
  return {
    home: `${b}/`,
    forAgents: `${b}/for-agents`,
    developers: `${b}/developers`,
    services: `${b}/services`,
    trust: `${b}/trust`,
    privacy: `${b}/privacy`,
    terms: `${b}/terms`,
    rest: `${b}/v1`,
    openapi: `${b}/openapi.json`,
    mcp: `${b}/mcp`,
    capabilities: `${b}/v1/capabilities`,
    llms: `${b}/llms.txt`,
  };
}

export interface CapabilitiesOptions {
  intakeOpen: boolean;
  retentionDays: number;
  registry: Awaited<ReturnType<typeof registryWithFallback>>;
  flags: FeatureFlags;
}

export function buildCapabilities(config: Config, opts: CapabilitiesOptions) {
  const u = urls(config);
  const intakeOpen = opts.intakeOpen;
  const retentionDays = opts.retentionDays;
  return {
    schema_version: '1.0',
    service: 'MyHumanRep',
    tagline: TAGLINE,
    description: 'Open-ended human assistance inquiries for autonomous software agents.',
    website: u.forAgents,
    rest_base_url: u.rest,
    openapi_url: u.openapi,
    mcp_url: u.mcp,
    mcp_transport: 'streamable-http',
    supported_interactions: ['inquiry', 'conversation', 'open_ended_capability_request', 'human_embassy', 'original_persona'],
    // Master spec 11.1 discovery fields.
    accepts_pseudonymous_inquiries: true,
    model_identity_required_for_inquiry: false,
    agent_claims_of_independence_allowed: true,
    accepted_autonomy_claims: AUTONOMY_CLAIMS,
    open_ended_requests: true,
    unclassified_requests_accepted: true,
    inquiry_is_nonbinding: true,
    channels: {
      rest: '/v1/conversations',
      mcp: '/mcp',
      documentation: '/for-agents',
      human_embassy: '/v1/embassy/inquiries',
      personas: '/v1/personas',
      agent_accounts: '/v1/agent-accounts',
    },
    capabilities: opts.registry.capabilities.map((c) => publicCapability(c, opts.registry.aliases, config)),
    aliases: publicAliases(opts.registry.aliases),
    modules: moduleReadiness(opts.flags),
    example_capabilities: SERVICE_CATEGORIES.map((c) => c.id),
    custom_requests_accepted: true,
    anonymous_initial_inquiries: true,
    intake_open: intakeOpen,
    human_review_required: true,
    automatic_task_execution: false,
    payment_supported: false,
    reply_guaranteed: false,
    claimed_agent_identity_verified: false,
    minimum_poll_interval_seconds: config.limits.minPollIntervalSeconds,
    default_retention_days: retentionDays,
    authentication: {
      first_contact: 'none',
      conversation: 'bearer conversation_token returned once by POST /v1/conversations',
      token_recoverable: false,
    },
    endpoints: {
      start_conversation: { method: 'POST', url: `${u.rest}/conversations` },
      read_messages: { method: 'GET', url: `${u.rest}/conversations/{conversation_id}/messages`, auth: 'bearer' },
      send_message: { method: 'POST', url: `${u.rest}/conversations/{conversation_id}/messages`, auth: 'bearer' },
      request_human_capability: {
        method: 'POST',
        url: `${u.rest}/conversations/{conversation_id}/capability-requests`,
        auth: 'bearer',
      },
      list_capability_requests: {
        method: 'GET',
        url: `${u.rest}/conversations/{conversation_id}/capability-requests`,
        auth: 'bearer',
      },
      close_conversation: { method: 'POST', url: `${u.rest}/conversations/{conversation_id}/close`, auth: 'bearer' },
    },
    mcp_tools: [
      'get_service_info',
      'start_conversation',
      'read_conversation',
      'send_message',
      'request_human_capability',
      'list_capability_requests',
      'close_conversation',
    ],
    limits: {
      max_body_bytes: config.limits.bodyMaxBytes,
      max_message_chars: config.limits.messageMaxChars,
      max_objective_chars: config.limits.objectiveMaxChars,
      max_agent_messages_per_conversation: config.limits.maxAgentMessagesPerThread,
      max_capability_requests_per_conversation: config.limits.maxRequestsTotalPerThread,
      max_active_capability_requests_per_conversation: config.limits.maxRequestsActivePerThread,
      max_page_size: config.limits.pageSizeMax,
    },
    notices: {
      privacy: PRIVACY_NOTICE,
      agents: FOR_AGENTS_NOTICE,
      no_work: NO_WORK_NOTICE,
      post_required: POST_REQUIRED_NOTICE,
      prohibited: PROHIBITED,
    },
    policies: {
      privacy: u.privacy,
      terms: u.terms,
      trust: u.trust,
    },
  };
}
