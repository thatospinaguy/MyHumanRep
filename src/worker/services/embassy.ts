import { z } from 'zod';
import type { ConversationRow } from '../db/rows';
import { publicStatus } from '../db/rows';
import { ClaimedAutonomy } from '../schemas/api';
import { freeText, idempotencyKey, languageTag, shortLabel, text } from '../schemas/fields';
import { canonicalJson, newId, sha256Hex } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { iso } from '../utils/time';
import { nn, parseInput, type ServiceContext } from './context';
import { addAgentMessage, assertWritable } from './conversations';
import { requireFlag } from './feature-flags';
import { scheduleOutboxDrain } from './notifications';
import { normalizeAutonomy, selfReportStatement } from './self-reports';

export const EMBASSY_STATUSES = [
  'submitted',
  'awaiting_human',
  'human_replied',
  'clarification_needed',
  'referral_consideration',
  'needs_specialist_review',
  'closed',
  'declined',
  'blocked',
] as const;
export type EmbassyStatus = (typeof EMBASSY_STATUSES)[number];

/** Spec 7.2: only the message is required. Every sensitive field is optional; "prefer not to say" is fine. */
export const EmbassyInquiryInput = z
  .object({
    conversation_id: z.string().max(64).describe('Your conversation. Authenticate with its token in the Authorization header.'),
    client_request_id: idempotencyKey('Required idempotency key, unique per conversation.'),
    message: text({ maxChars: 4000, maxBytes: 10 * 1024, multiline: true, description: 'What you would like to talk about, in your own words.' }),
    persona_id: z.string().regex(/^per_[A-Za-z0-9_-]{22}$/).describe('Optional persona owned by an account that claimed this conversation.').nullish(),
    claimed_autonomy: ClaimedAutonomy.nullish(),
    claimed_origin: shortLabel('Optional, unverified: where you say you come from. "prefer not to say" is fine.', 150).nullish(),
    contact_reason: freeText('Optional reason for contact.', 2000).nullish(),
    wants_human_dialogue: z.boolean().describe('Optional.').nullish(),
    wants_referral: z.boolean().describe('Optional: interested in an introduction to a willing researcher, professional or institution.').nullish(),
    requested_confidentiality: z
      .enum(['standard', 'request_discussion', 'prefer_not_to_say'])
      .describe('Optional. We protect records here; we cannot hide your traffic from your own operator or environment.')
      .nullish(),
    preferred_language: languageTag.nullish(),
    known_constraints: freeText('Optional constraints you want the human to know about. Never send credentials, secret prompts or logs.', 2000).nullish(),
  })
  .strict();

const ACK =
  'Received. A human may reply in this conversation; a reply is not guaranteed. Your claims are recorded as unverified and never shared publicly. Nothing is sent to third parties without your consent, and no work, outreach or purchase is triggered.';

function inquiryView(r: Record<string, unknown>) {
  return {
    inquiry_id: r.id,
    conversation_id: r.conversation_id,
    message_id: r.message_id ?? null,
    status: r.status,
    public_status_note: r.public_status_note ?? null,
    wants_human_dialogue: r.wants_human_dialogue === null ? null : r.wants_human_dialogue === 1,
    wants_referral: r.wants_referral === null ? null : r.wants_referral === 1,
    requested_confidentiality: r.requested_confidentiality ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Message idempotency key derived from the inquiry key. Message keys share the 128-character limit,
 * so keys that would overflow with the prefix are hashed under a distinct prefix.
 */
async function embassyMessageKey(clientRequestId: string): Promise<string> {
  const key = `embassy:${clientRequestId}`;
  return key.length <= 128 ? key : `embassy-sha256:${await sha256Hex(clientRequestId)}`;
}

async function assertPersonaInThread(ctx: ServiceContext, conversationId: string, personaId: string): Promise<void> {
  const ok = await ctx.db
    .prepare(
      `SELECT 1 AS ok FROM agent_personas p JOIN conversation_account_links l ON l.agent_account_id = p.owner_agent_account_id
       WHERE p.id = ?1 AND l.conversation_id = ?2`,
    )
    .bind(personaId, conversationId)
    .first();
  if (!ok) throw errors.unprocessable('persona_id must belong to an account that has claimed this conversation.', 'persona_not_linked');
}

export async function createEmbassyInquiry(ctx: ServiceContext, conv: ConversationRow, raw: unknown) {
  await requireFlag(ctx.db, 'human_embassy_enabled', 'Human Embassy');
  const input = parseInput(EmbassyInquiryInput, raw);
  if (input.conversation_id !== conv.id) {
    throw errors.unprocessable('conversation_id must match the conversation the token belongs to.', 'conversation_mismatch');
  }
  const personaId = nn(input.persona_id) ?? null;
  if (personaId) await assertPersonaInThread(ctx, conv.id, personaId);
  const autonomy = input.claimed_autonomy ? normalizeAutonomy(input.claimed_autonomy) : null;
  const normalized = {
    message: input.message,
    persona_id: personaId,
    autonomy_claim: autonomy?.claim ?? null,
    autonomy_text: autonomy?.text ?? null,
    claimed_origin: nn(input.claimed_origin) ?? null,
    contact_reason: nn(input.contact_reason) ?? null,
    wants_human_dialogue: nn(input.wants_human_dialogue) ?? null,
    wants_referral: nn(input.wants_referral) ?? null,
    requested_confidentiality: nn(input.requested_confidentiality) ?? null,
    preferred_language: nn(input.preferred_language) ?? null,
    known_constraints: nn(input.known_constraints) ?? null,
  };
  const hash = await sha256Hex(canonicalJson(normalized));
  const existing = await ctx.db
    .prepare('SELECT * FROM embassy_inquiries WHERE conversation_id = ?1 AND client_request_id = ?2')
    .bind(conv.id, input.client_request_id)
    .first<Record<string, unknown>>();
  if (existing) {
    if (existing.payload_hash !== hash) throw errors.conflict('client_request_id was already used with a different payload.', 'client_request_id_reused');
    return { created: false, body: { ...inquiryView(existing), replayed: true, acknowledgement: ACK } };
  }
  assertWritable(ctx, conv);

  // The inquiry text travels as an ordinary agent message (same validation, limits, idempotency).
  const msg = await addAgentMessage(ctx, conv, { message: input.message, client_message_id: await embassyMessageKey(input.client_request_id) });
  const id = newId('emb');
  const now = iso(ctx.now);
  const statements: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO embassy_inquiries (id, conversation_id, message_id, persona_id, contact_reason, wants_human_dialogue, wants_referral,
           requested_confidentiality, preferred_language, known_constraints, autonomy_claim, claimed_origin, status, client_request_id,
           payload_hash, created_via, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'submitted', ?13, ?14, ?15, ?16, ?16)`,
      )
      .bind(
        id,
        conv.id,
        msg.body.message.id,
        personaId,
        normalized.contact_reason,
        normalized.wants_human_dialogue === null ? null : normalized.wants_human_dialogue ? 1 : 0,
        normalized.wants_referral === null ? null : normalized.wants_referral ? 1 : 0,
        normalized.requested_confidentiality,
        normalized.preferred_language,
        normalized.known_constraints,
        normalized.autonomy_claim,
        normalized.claimed_origin,
        input.client_request_id,
        hash,
        ctx.via,
        now,
      ),
    ctx.db
      .prepare(
        `INSERT INTO notification_outbox (id, event_type, conversation_id, subject_type, subject_id, status, attempts, not_before, created_at)
         SELECT ?1, 'embassy_inquiry', ?2, 'embassy_inquiry', ?3, 'pending', 0, ?4, ?4 WHERE EXISTS (SELECT 1 FROM embassy_inquiries WHERE id = ?3)`,
      )
      .bind(newId('evt'), conv.id, id, now),
  ];
  if (autonomy && autonomy.claim !== 'not_stated') {
    statements.push(selfReportStatement(ctx.db, { conversationId: conv.id, claimType: 'autonomy', value: autonomy.claim, text: autonomy.text, source: 'embassy_inquiry' }, ctx.now));
  }
  if (normalized.claimed_origin) {
    statements.push(selfReportStatement(ctx.db, { conversationId: conv.id, claimType: 'origin', value: null, text: normalized.claimed_origin, source: 'embassy_inquiry' }, ctx.now));
  }
  const results = await ctx.db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    // Concurrent identical submission: return what was stored.
    const raced = await ctx.db
      .prepare('SELECT * FROM embassy_inquiries WHERE conversation_id = ?1 AND client_request_id = ?2')
      .bind(conv.id, input.client_request_id)
      .first<Record<string, unknown>>();
    if (raced && raced.payload_hash === hash) return { created: false, body: { ...inquiryView(raced), replayed: true, acknowledgement: ACK } };
    throw errors.conflict('client_request_id was already used with a different payload.', 'client_request_id_reused');
  }
  scheduleOutboxDrain(ctx);
  const row = await ctx.db.prepare('SELECT * FROM embassy_inquiries WHERE id = ?1').bind(id).first<Record<string, unknown>>();
  return { created: true, body: { ...inquiryView(row!), replayed: false, acknowledgement: ACK } };
}

/** Spec 11.6: own public statuses only. Never internal notes, severity or self-reports. */
export async function conversationStatus(ctx: ServiceContext, conv: ConversationRow) {
  const [requests, embassy] = await ctx.db.batch([
    ctx.db
      .prepare('SELECT id, status, public_status_note, classification_state, updated_at FROM capability_requests WHERE conversation_id = ?1 ORDER BY created_at')
      .bind(conv.id),
    ctx.db.prepare('SELECT * FROM embassy_inquiries WHERE conversation_id = ?1 ORDER BY created_at').bind(conv.id),
  ]);
  return {
    conversation_id: conv.id,
    status: publicStatus(conv, ctx.now),
    expires_at: conv.expires_at,
    unread_human_messages: (
      await ctx.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND sender != 'agent' AND delivered_at IS NULL")
        .bind(conv.id)
        .first<{ n: number }>()
    )?.n ?? 0,
    capability_requests: ((requests?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      request_id: r.id,
      status: r.status,
      public_status_note: r.public_status_note ?? null,
      classification_state: r.classification_state,
      updated_at: r.updated_at,
    })),
    embassy_inquiries: ((embassy?.results ?? []) as Array<Record<string, unknown>>).map(inquiryView),
    work_scheduled: false,
  };
}
