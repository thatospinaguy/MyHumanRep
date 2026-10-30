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
import { candidateStatements, classifyHints } from './capability-catalog';
import { requireFlag } from './feature-flags';
import { scheduleOutboxDrain } from './notifications';
import { ACTIVE_REQUEST_STATUSES, nextConversationStatus } from './state';

const RECEIVED_MESSAGE = 'Request received for review. No work has been accepted or scheduled.';
/** Spec 5.2 agent-facing wording for requests that match no registry entry. */
const UNFAMILIAR_MESSAGE = 'We received an unfamiliar request for human review; no work is committed.';

function parseJsonArray(json: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A request may reference a persona only if an agent account that has claimed this conversation
 * owns it (spec 13.3, ACC-13). Persona IDs are never credentials.
 */
async function assertPersonaUsableInThread(_ctx: ServiceContext, _conversationId: string, _personaId: string): Promise<void> {
  // PHASE2: replaced by the ownership query once agent accounts and personas exist.
  throw errors.unprocessable(
    'persona_id must be one of your personas, and this conversation must be claimed by the same agent account (POST /v1/agent-accounts/me/claim-conversation).',
    'persona_not_linked',
  );
}

export function toPublicRequest(row: CapabilityRequestRow): z.infer<typeof PublicCapabilityRequest> {
  return {
    request_id: row.id,
    conversation_id: row.conversation_id,
    client_request_id: row.client_request_id,
    status: row.status,
    public_status_note: row.public_status_note,
    objective: row.objective,
    problem_statement: row.problem_statement ?? null,
    desired_outcome: row.desired_outcome ?? null,
    service_tags: parseJsonArray(row.service_tags_json),
    human_capability_needed: row.human_capability_needed,
    context: row.context,
    category_hint: row.category_hint,
    classification: {
      state: row.classification_state ?? 'unclassified',
      capabilities: parseJsonArray(row.classified_capabilities_json),
      note:
        (row.classification_state ?? 'unclassified') === 'unclassified'
          ? UNFAMILIAR_MESSAGE
          : 'Matched to the capability registry from your hints. A human still reviews the request; the match is not a commitment.',
    },
    location_text: row.location_text,
    deadline_preference: row.deadline_preference,
    timing_preference: row.deadline_preference,
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
    evidence_requirements: row.evidence_requirements ?? null,
    preferred_rep_id: row.preferred_rep_id ?? null,
    persona_id: row.persona_id ?? null,
    authorization_description: row.authorization_description ?? null,
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
  problem_statement, desired_outcome, service_tags_json, evidence_requirements, preferred_rep_id, persona_id,
  authorization_description, classification_state, classified_capabilities_json,
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
    message: (row.classification_state ?? 'unclassified') === 'unclassified' ? UNFAMILIAR_MESSAGE : RECEIVED_MESSAGE,
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
  await requireFlag(ctx.db, 'capability_requests_enabled', 'Capability requests');
  const input = parseInput(CapabilityRequestInput, raw);

  // Budget: legacy major-unit pair or master-spec minor-unit object. Both may be sent only if equal.
  let budgetMinor: number | null = null;
  let currency = nn(input.budget_currency) ?? null;
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
  const budget = nn(input.budget);
  if (budget) {
    if (budgetMinor !== null && (budgetMinor !== budget.amount_minor || currency !== budget.currency)) {
      throw errors.unprocessable('budget and budget_amount/budget_currency disagree. Send one form.', 'conflicting_fields');
    }
    budgetMinor = budget.amount_minor;
    currency = budget.currency;
  }
  const deadline = nn(input.deadline_preference) ?? null;
  const timing = nn(input.timing_preference) ?? null;
  if (deadline && timing && deadline !== timing) {
    throw errors.unprocessable('deadline_preference and timing_preference disagree. Send one of them.', 'conflicting_fields');
  }
  const objective = nn(input.objective) ?? nn(input.problem_statement)!;
  const personaId = nn(input.persona_id) ?? null;
  if (personaId) await assertPersonaUsableInThread(ctx, conv.id, personaId);

  const serviceTags = [...new Set(nn(input.service_tags) ?? [])];
  const extra = {
    problem_statement: nn(input.problem_statement) ?? null,
    desired_outcome: nn(input.desired_outcome) ?? null,
    service_tags: serviceTags,
    evidence_requirements: nn(input.evidence_requirements) ?? null,
    preferred_rep_id: nn(input.preferred_rep_id) ?? null,
    persona_id: personaId,
    authorization_description: nn(input.authorization_description) ?? null,
  };
  const normalized = {
    objective,
    human_capability_needed: nn(input.human_capability_needed) ?? null,
    context: nn(input.context) ?? null,
    category_hint: nn(input.category_hint) ?? null,
    location_text: nn(input.location_text) ?? null,
    deadline_preference: deadline ?? timing,
    budget_amount_minor: budgetMinor,
    budget_currency: budgetMinor === null ? null : currency,
    deliverables: nn(input.deliverables) ?? null,
    why_human: nn(input.why_human) ?? null,
    confidentiality_preference: nn(input.confidentiality_preference) ?? 'standard',
  };
  // Master-spec fields join the idempotency hash only when present, so identical V1 replays keep
  // the hash they had before the upgrade.
  const hashed: Record<string, unknown> = { ...normalized };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== null && !(Array.isArray(v) && v.length === 0)) hashed[k] = v;
  }
  const payloadHash = await sha256Hex(canonicalJson(hashed));

  const existing = await findByClientRequestId(ctx, conv.id, input.client_request_id);
  if (existing) return replayOrConflict(existing, payloadHash);

  assertWritable(ctx, conv);
  const nextStatus = nextConversationStatus(conv.status, 'agent_capability_request');
  if (!nextStatus) throw errors.conflict('This conversation is closed.', 'conversation_closed');

  const hints = [normalized.category_hint, ...serviceTags].filter((h): h is string => typeof h === 'string');
  const classification = await classifyHints(ctx.db, hints);

  const { maxRequestsTotalPerThread: maxTotal, maxRequestsActivePerThread: maxActive } = ctx.config.limits;
  const activeList = ACTIVE_REQUEST_STATUSES.map((s) => `'${s}'`).join(',');
  const id = newId('cap');
  const now = iso(ctx.now);

  const results = await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO capability_requests (id, conversation_id, client_request_id, payload_hash, objective,
           human_capability_needed, context, category_hint, location_text, deadline_preference, budget_amount_minor,
           budget_currency, deliverables, why_human, confidentiality_preference, status, created_via, created_at, updated_at,
           problem_statement, desired_outcome, service_tags_json, evidence_requirements, preferred_rep_id, persona_id,
           authorization_description, classification_state, classified_capabilities_json)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'submitted', ?16, ?17, ?17,
           ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28
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
        extra.problem_statement,
        extra.desired_outcome,
        JSON.stringify(serviceTags),
        extra.evidence_requirements,
        extra.preferred_rep_id,
        extra.persona_id,
        extra.authorization_description,
        classification.state,
        JSON.stringify(classification.capabilities),
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
    // Unfamiliar hints go to the owner's review queue; nothing is published as a service (spec 5.2).
    ...candidateStatements(ctx.db, id, hints, classification.unknown_hints, ctx.now),
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
