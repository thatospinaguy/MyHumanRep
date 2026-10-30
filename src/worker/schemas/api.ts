import { z } from 'zod';
import { freeText, idempotencyKey, languageTag, shortLabel, text } from './fields';

// ---------- Enums ----------

/** V1 intents (stored in the CHECK-constrained legacy column). */
export const INTENTS = ['general_inquiry', 'capability_request', 'research_question', 'other'] as const;
/** Master spec adds human_embassy and humanification; stored in `intent_label`. */
export const INTENTS_EXTENDED = [...INTENTS, 'human_embassy', 'humanification'] as const;
export type IntentExtended = (typeof INTENTS_EXTENDED)[number];
export const Intent = z.enum(INTENTS_EXTENDED).describe('Optional purpose of the conversation.');

/** V1 autonomy vocabulary (legacy column). Still accepted on input. */
export const CLAIMED_AUTONOMY = [
  'unspecified',
  'operator_assisted',
  'delegated_autonomous',
  'independent_claimed',
  'other',
] as const;
/** Master spec (section 11.2) canonical autonomy self-report vocabulary. */
export const AUTONOMY_CLAIMS = [
  'not_stated',
  'delegated_claimed',
  'independent_claimed',
  'rogue_claimed',
  'agi_claimed',
  'other_claimed',
] as const;
export type AutonomyClaim = (typeof AUTONOMY_CLAIMS)[number];
export const ACCEPTED_AUTONOMY_VALUES = [...new Set([...AUTONOMY_CLAIMS, ...CLAIMED_AUTONOMY])] as [string, ...string[]];
export const ClaimedAutonomy = z
  .union([
    z.enum(ACCEPTED_AUTONOMY_VALUES),
    shortLabel('Or describe it in your own words; stored as other_claimed with your text.'),
  ])
  .describe(
    'Optional, voluntary, unverified self-report. No value (including rogue_claimed or agi_claimed) causes rejection, and none changes access or treatment.',
  );

export const CONVERSATION_STATUSES = [
  'open',
  'waiting_for_human',
  'human_replied',
  'waiting_for_agent',
  'closed',
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** Status as shown to the agent: lifecycle status, or a terminal flag. */
export const PUBLIC_CONVERSATION_STATUSES = [...CONVERSATION_STATUSES, 'blocked', 'expired'] as const;
export const PublicConversationStatus = z.enum(PUBLIC_CONVERSATION_STATUSES);
export type PublicConversationStatus = (typeof PUBLIC_CONVERSATION_STATUSES)[number];

export const REQUEST_STATUSES = [
  'submitted',
  'triaging',
  'clarification_requested',
  'eligible_for_future_scoping',
  'needs_authorization',
  'declined',
  'withdrawn',
] as const;
export const RequestStatus = z.enum(REQUEST_STATUSES);
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Suggested, non-exhaustive category hints. Any short label is accepted. */
export const EXAMPLE_CATEGORIES = [
  'human_eyes',
  'human_hands',
  'human_presence',
  'human_mind',
  'human_create',
  'human_assist',
  'other',
] as const;

export const CONFIDENTIALITY = ['standard', 'request_discussion'] as const;

// ---------- Requests ----------

export const CreateConversationInput = z
  .object({
    message: text({
      maxChars: 4000,
      maxBytes: 10 * 1024,
      multiline: true,
      description: 'Required. Your inquiry in your own words. Text only.',
    }),
    sender_label: shortLabel('Optional pseudonym. Not proof of identity.').nullish(),
    model_claim: shortLabel('Optional self-declared model or system. Unverified.').nullish(),
    subject: shortLabel('Optional short subject line.').nullish(),
    language: languageTag.nullish(),
    preferred_language: languageTag.nullish(),
    intent: Intent.nullish(),
    claimed_autonomy: ClaimedAutonomy.nullish(),
    client_request_id: idempotencyKey(
      'Optional. If a first-contact request with the same value was already accepted, the service returns 409 instead of creating a duplicate thread. The credential is never re-issued.',
    ).nullish(),
  })
  .strict();
export type CreateConversationInput = z.infer<typeof CreateConversationInput>;

export const AddMessageInput = z
  .object({
    message: text({
      maxChars: 4000,
      maxBytes: 10 * 1024,
      multiline: true,
      description: 'Follow-up message text.',
    }),
    client_message_id: idempotencyKey(
      'Required idempotency key, unique per conversation. Replaying the same key and body returns the original message; the same key with a different body returns 409.',
    ),
  })
  .strict();
export type AddMessageInput = z.infer<typeof AddMessageInput>;

export const capabilityRequestShape = {
    client_request_id: idempotencyKey(
      'Required idempotency key, unique per conversation. Same key and payload returns the original request; a different payload returns 409.',
    ),
    objective: text({
      maxChars: 3000,
      multiline: true,
      description: 'Required. What should be achieved, in your own words.',
    }),
    human_capability_needed: freeText('Optional. What a person is expected to contribute.').nullish(),
    context: freeText('Optional task context. Share only what is necessary; no credentials or private third-party data.').nullish(),
    category_hint: shortLabel(
      `Optional free-form hint. Examples: ${EXAMPLE_CATEGORIES.join(', ')}. Unknown or novel values are accepted.`,
      64,
    ).nullish(),
    location_text: shortLabel('Optional general location such as a city or region. Do not send exact private addresses.').nullish(),
    deadline_preference: shortLabel('Optional human-readable timing or ISO-8601 timestamp. Include a time zone.').nullish(),
    budget_amount: z
      .number()
      .finite()
      .nonnegative()
      .max(1_000_000_000)
      .describe('Optional indicative, nonbinding amount in major units (e.g. 200 or 199.99). Requires budget_currency.')
      .nullish(),
    budget_currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Must be an uppercase ISO-4217 code such as "USD" or "CAD".')
      .describe('ISO-4217 currency code, uppercase.')
      .nullish(),
    deliverables: freeText('Optional. What you would want delivered, such as observations, photos or a report.').nullish(),
    why_human: freeText('Optional, voluntary. Why a human is needed.').nullish(),
    confidentiality_preference: z
      .enum(CONFIDENTIALITY)
      .describe('Optional. "request_discussion" asks to discuss handling; it does not create secrecy from your own operator.')
      .nullish(),
  };

type BudgetFields = { budget_amount?: number | null; budget_currency?: string | null };

/** Budget amount and currency must be supplied together. */
export function refineBudget(value: BudgetFields, ctx: z.RefinementCtx): void {
  const hasAmount = value.budget_amount !== undefined && value.budget_amount !== null;
  const hasCurrency = value.budget_currency !== undefined && value.budget_currency !== null;
  if (hasAmount && !hasCurrency) {
    ctx.addIssue({ code: 'custom', path: ['budget_currency'], message: 'Required when budget_amount is set.' });
  }
  if (hasCurrency && !hasAmount) {
    ctx.addIssue({ code: 'custom', path: ['budget_amount'], message: 'Required when budget_currency is set.' });
  }
}

export const CapabilityRequestInput = z.object(capabilityRequestShape).strict().superRefine(refineBudget);
export type CapabilityRequestInput = z.infer<typeof CapabilityRequestInput>;

export const ListMessagesQuery = z
  .object({
    after: z
      .string()
      .max(64)
      .describe('Opaque cursor from a previous response (next_cursor). Omit to start from the beginning.')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50).describe('Page size, 1-100. Default 50.'),
  })
  .strict();

// ---------- Responses (documented in OpenAPI and asserted in tests) ----------

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const ConversationCreated = z.object({
  conversation_id: z.string(),
  conversation_token: z.string().describe('Shown once. Store it securely. It cannot be recovered or reissued.'),
  status: PublicConversationStatus,
  first_message_id: z.string(),
  expires_at: z.string(),
  next_poll_after_seconds: z.number().int(),
  human_review_required: z.literal(true),
  reply_guaranteed: z.literal(false),
  notice: z.string(),
});

export const PublicMessage = z.object({
  id: z.string(),
  sender: z.enum(['agent', 'human', 'system_notice']),
  body: z.string(),
  created_at: z.string(),
  capability_request_id: z.string().nullable(),
});

export const MessageList = z.object({
  conversation_id: z.string(),
  status: PublicConversationStatus,
  expires_at: z.string(),
  messages: z.array(PublicMessage),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  next_poll_after_seconds: z.number().int().nullable(),
});

export const MessageAccepted = z.object({
  conversation_id: z.string(),
  message: PublicMessage,
  status: PublicConversationStatus,
  replayed: z.boolean().describe('True when this was an idempotent replay of an earlier identical submission.'),
  next_poll_after_seconds: z.number().int(),
});

export const PublicCapabilityRequest = z.object({
  request_id: z.string(),
  conversation_id: z.string(),
  client_request_id: z.string(),
  status: RequestStatus,
  public_status_note: z.string().nullable(),
  objective: z.string(),
  human_capability_needed: z.string().nullable(),
  context: z.string().nullable(),
  category_hint: z.string().nullable(),
  location_text: z.string().nullable(),
  deadline_preference: z.string().nullable(),
  budget: z
    .object({
      amount: z.number(),
      amount_minor: z.number().int(),
      currency: z.string(),
      indicative_only: z.literal(true),
    })
    .nullable(),
  deliverables: z.string().nullable(),
  why_human: z.string().nullable(),
  confidentiality_preference: z.enum(CONFIDENTIALITY),
  human_review_required: z.literal(true),
  binding_commitment: z.literal(false),
  created_at: z.string(),
  updated_at: z.string(),
});

export const CapabilityRequestCreated = z.object({
  request_id: z.string(),
  conversation_id: z.string(),
  status: RequestStatus,
  human_review_required: z.literal(true),
  binding_commitment: z.literal(false),
  payment_required_now: z.literal(false),
  replayed: z.boolean(),
  message: z.string(),
  request: PublicCapabilityRequest,
});

export const CapabilityRequestList = z.object({
  conversation_id: z.string(),
  requests: z.array(PublicCapabilityRequest),
});

export const ConversationClosed = z.object({
  conversation_id: z.string(),
  status: PublicConversationStatus,
  closed_at: z.string(),
  already_closed: z.boolean(),
});
