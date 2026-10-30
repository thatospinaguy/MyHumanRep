import type { z } from 'zod';
import type { CapabilityRequestRow, ConversationRow } from '../db/rows';
import {
  CapabilityRequestInput,
  type CapabilityRequestCreated,
  type CapabilityRequestList,
  type PublicCapabilityRequest,
} from '../schemas/api';
import { canonicalJson, newId, sha256Hex } from '../utils/crypto';
import { ApiError, errors } from '../utils/http-errors';
import { fromMinorUnits, toMinorUnits } from '../utils/money';
import { iso } from '../utils/time';
import { nn, parseInput, type ServiceContext } from './context';
import { assertWritable } from './conversations';
import { scheduleOutboxDrain } from './notifications';
import { ACTIVE_REQUEST_STATUSES, nextConversationStatus } from './state';

const RECEIVED_MESSAGE = 'Request received for review. No work has been accepted or scheduled.';

export function toPublicRequest(row: CapabilityRequestRow): z.infer<typeof PublicCapabilityRequest> {
  return {
    request_id: row.id,
    conversation_id: row.conversation_id,
    client_request_id: row.client_request_id,
    status: row.status,
    public_status_note: row.public_status_note,
    objective: row.objective,
    human_capability_needed: row.human_capability_needed,
    context: row.context,
    category_hint: row.category_hint,
    location_text: row.location_text,
    deadline_preference: row.deadline_preference,
    budget:
      row.budget_amount_minor !== null && row.budget_currency
        ? {
            amount: fromMinorUnits(row.budget_amount_minor, row.budget_currency),
            amount_minor: row.budget_amount_minor,
            currency: row.budget_currency,
            indicative_only: true,
          }
        : null,
    deliverables: row.deliverables,
    why_human: row.why_human,
    confidentiality_preference: row.confidentiality_preference,
    human_review_required: true,
    binding_commitment: false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Explicit column list: internal_notes and internal_category never leave via the agent API. */
const PUBLIC_COLUMNS = `id, conversation_id, client_request_id, payload_hash, objective, human_capability_needed, context,
  category_hint, location_text, deadline_preference, budget_amount_minor, budget_currency, deliverables, why_human,
  confidentiality_preference, status, public_status_note, created_via, created_at, updated_at,
  NULL AS internal_notes, NULL AS internal_category`;

async function findByClientRequestId(ctx: ServiceContext, conversationId: string, clientRequestId: string) {
  return ctx.db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM capability_requests WHERE conversation_id = ?1 AND client_request_id = ?2`)
    .bind(conversationId, clientRequestId)
    .first<CapabilityRequestRow>();
}

function created(row: CapabilityRequestRow, replayed: boolean): z.infer<typeof CapabilityRequestCreated> {
  return {
    request_id: row.id,
    conversation_id: row.conversation_id,
    status: row.status,
    human_review_required: true,
    binding_commitment: false,
    payment_required_now: false,
    replayed,
    message: RECEIVED_MESSAGE,
    request: toPublicRequest(row),
  };
}

function replayOrConflict(existing: CapabilityRequestRow, payloadHash: string) {
  if (existing.payload_hash !== payloadHash) {
    throw errors.conflict(
      'client_request_id was already used with a different payload. Use a new client_request_id for a new request, or send a message to clarify the existing one.',
      'client_request_id_reused',
    );
  }
  return { created: false, body: created(existing, true) };
}

export async function createCapabilityRequest(
  ctx: ServiceContext,
  conv: ConversationRow,
  raw: unknown,
): Promise<{ created: boolean; body: z.infer<typeof CapabilityRequestCreated> }> {
  const input = parseInput(CapabilityRequestInput, raw);

  let budgetMinor: number | null = null;
  const currency = nn(input.budget_currency) ?? null;
  const amount = nn(input.budget_amount);
  if (amount !== undefined && currency) {
    budgetMinor = toMinorUnits(amount, currency);
    if (budgetMinor === null) {
      throw new ApiError('invalid_request', 'budget_amount has more decimal places than the currency allows.', {
        reason: 'validation_failed',
        issues: [{ path: 'budget_amount', message: `Too many decimal places for ${currency}.` }],
      });
    }
  }

  const normalized = {
    objective: input.objective,
    human_capability_needed: nn(input.human_capability_needed) ?? null,
    context: nn(input.context) ?? null,
    category_hint: nn(input.category_hint) ?? null,
    location_text: nn(input.location_text) ?? null,
    deadline_preference: nn(input.deadline_preference) ?? null,
    budget_amount_minor: budgetMinor,
    budget_currency: budgetMinor === null ? null : currency,
    deliverables: nn(input.deliverables) ?? null,
    why_human: nn(input.why_human) ?? null,
    confidentiality_preference: nn(input.confidentiality_preference) ?? 'standard',
  };
  const payloadHash = await sha256Hex(canonicalJson(normalized));

  const existing = await findByClientRequestId(ctx, conv.id, input.client_request_id);
  if (existing) return replayOrConflict(existing, payloadHash);

  assertWritable(ctx, conv);
  const nextStatus = nextConversationStatus(conv.status, 'agent_capability_request');
  if (!nextStatus) throw errors.conflict('This conversation is closed.', 'conversation_closed');

  const { maxRequestsTotalPerThread: maxTotal, maxRequestsActivePerThread: maxActive } = ctx.config.limits;
  const activeList = ACTIVE_REQUEST_STATUSES.map((s) => `'${s}'`).join(',');
  const id = newId('cap');
  const now = iso(ctx.now);

  const results = await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO capability_requests (id, conversation_id, client_request_id, payload_hash, objective,
           human_capability_needed, context, category_hint, location_text, deadline_preference, budget_amount_minor,
           budget_currency, deliverables, why_human, confidentiality_preference, status, created_via, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'submitted', ?16, ?17, ?17
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?2 AND closed_at IS NULL AND blocked_at IS NULL AND expires_at > ?17)
           AND (SELECT COUNT(*) FROM capability_requests WHERE conversation_id = ?2) < ?18
           AND (SELECT COUNT(*) FROM capability_requests WHERE conversation_id = ?2 AND status IN (${activeList})) < ?19`,
      )
      .bind(
        id,
        conv.id,
        input.client_request_id,
        payloadHash,
        normalized.objective,
        normalized.human_capability_needed,
        normalized.context,
        normalized.category_hint,
        normalized.location_text,
        normalized.deadline_preference,
        normalized.budget_amount_minor,
        normalized.budget_currency,
        normalized.deliverables,
        normalized.why_human,
        normalized.confidentiality_preference,
        ctx.via,
        now,
        maxTotal,
        maxActive,
      ),
    ctx.db
      .prepare(
        `UPDATE conversations SET status = ?3, updated_at = ?2
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM capability_requests WHERE id = ?4)`,
      )
      .bind(conv.id, now, nextStatus, id),
    ctx.db
      .prepare(
        `INSERT INTO notification_outbox (id, event_type, conversation_id, capability_request_id, status, attempts, not_before, created_at)
         SELECT ?1, 'capability_request', ?2, ?3, 'pending', 0, ?4, ?4
         WHERE EXISTS (SELECT 1 FROM capability_requests WHERE id = ?3)`,
      )
      .bind(newId('evt'), conv.id, id, now),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const raced = await findByClientRequestId(ctx, conv.id, input.client_request_id);
    if (raced) return replayOrConflict(raced, payloadHash);
    const fresh = await ctx.db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(conv.id).first<ConversationRow>();
    if (!fresh) throw errors.unauthorized();
    assertWritable(ctx, fresh);
    const counts = await ctx.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status IN (${activeList}) THEN 1 ELSE 0 END) AS active
         FROM capability_requests WHERE conversation_id = ?1`,
      )
      .bind(conv.id)
      .first<{ total: number; active: number | null }>();
    if ((counts?.total ?? 0) >= maxTotal) {
      throw errors.conflict(
        `This conversation reached its lifetime limit of ${maxTotal} capability requests. Start a new conversation.`,
        'request_limit_reached',
      );
    }
    throw errors.conflict(
      `This conversation already has ${maxActive} requests under review. Wait for a decision or describe additional needs in a message.`,
      'active_request_limit_reached',
    );
  }

  scheduleOutboxDrain(ctx);
  const row = await ctx.db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM capability_requests WHERE id = ?1`)
    .bind(id)
    .first<CapabilityRequestRow>();
  if (!row) throw new ApiError('internal_error', 'Request could not be read back.');
  return { created: true, body: created(row, false) };
}

export async function listCapabilityRequests(
  ctx: ServiceContext,
  conv: ConversationRow,
): Promise<z.infer<typeof CapabilityRequestList>> {
  const { results } = await ctx.db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM capability_requests WHERE conversation_id = ?1 ORDER BY created_at ASC, id ASC`)
    .bind(conv.id)
    .all<CapabilityRequestRow>();
  return { conversation_id: conv.id, requests: results.map(toPublicRequest) };
}
