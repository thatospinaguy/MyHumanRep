import { z } from 'zod';
import { freeText } from '../schemas/fields';
import { errors } from '../utils/http-errors';
import { iso } from '../utils/time';
import type { AdminContext } from './admin';
import { auditStatement } from './audit';
import { parseInput } from './context';
import { EMBASSY_STATUSES } from './embassy';
import { getMetrics } from './metrics';

export const EmbassyPatchInput = z
  .object({
    status: z.enum(EMBASSY_STATUSES).optional(),
    public_status_note: z.union([freeText('Agent-visible note.', 2000), z.literal(''), z.null()]).optional(),
    internal_notes: z.union([freeText('Private owner note.', 5000), z.literal(''), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export const SelfReportPatchInput = z
  .object({ evidence_status: z.enum(['self_reported_unverified', 'system_observed', 'third_party_corrob', 'human_assessed', 'unknown']) })
  .strict();

export async function listEmbassy(ctx: AdminContext, status?: string) {
  const s = status && (EMBASSY_STATUSES as readonly string[]).includes(status) ? status : null;
  const where = s ? 'WHERE e.status = ?1' : "WHERE e.status NOT IN ('closed','declined','blocked')";
  const { results } = await ctx.db
    .prepare(
      `SELECT e.id, e.conversation_id, e.status, e.public_status_note, e.contact_reason, e.wants_human_dialogue, e.wants_referral,
              e.requested_confidentiality, e.autonomy_claim, e.claimed_origin, e.persona_id, e.created_via, e.created_at, e.updated_at,
              c.sender_label, c.subject, substr(m.body, 1, 280) AS excerpt
       FROM embassy_inquiries e JOIN conversations c ON c.id = e.conversation_id LEFT JOIN messages m ON m.id = e.message_id
       ${where} ORDER BY e.created_at DESC LIMIT 200`,
    )
    .bind(...(s ? [s] : []))
    .all();
  return { items: results.map((r) => ({ ...r, claims_verified: false })) };
}

export async function getEmbassyInquiry(ctx: AdminContext, id: string) {
  const row = await ctx.db.prepare('SELECT * FROM embassy_inquiries WHERE id = ?1').bind(id).first<Record<string, unknown>>();
  if (!row) throw errors.notFound('Embassy inquiry not found.');
  const [message, reports] = await ctx.db.batch([
    ctx.db.prepare('SELECT id, body, created_at FROM messages WHERE id = ?1').bind(row.message_id ?? ''),
    ctx.db
      .prepare('SELECT id, claim_type, claim_value, claim_text, evidence_status, source, created_at FROM agent_self_reports WHERE conversation_id = ?1 ORDER BY created_at')
      .bind(row.conversation_id),
    auditStatement(ctx.db, ctx.actor, 'embassy_inquiry.view', 'embassy_inquiry', id, null, ctx.now),
  ]);
  return {
    inquiry: { ...row, claims_verified: false },
    message: message?.results?.[0] ?? null,
    self_reports: reports?.results ?? [],
    work_scheduled: false as const,
  };
}

export async function patchEmbassyInquiry(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(EmbassyPatchInput, raw);
  const row = await ctx.db.prepare('SELECT status FROM embassy_inquiries WHERE id = ?1').bind(id).first<{ status: string }>();
  if (!row) throw errors.notFound('Embassy inquiry not found.');
  const sets = ['updated_at = ?2'];
  const params: unknown[] = [iso(ctx.now)];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = ?${params.length + 1}`);
  };
  if (input.status !== undefined) set('status', input.status);
  if (input.public_status_note !== undefined) set('public_status_note', input.public_status_note || null);
  if (input.internal_notes !== undefined) set('internal_notes', input.internal_notes || null);
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE embassy_inquiries SET ${sets.join(', ')} WHERE id = ?1`).bind(id, ...params),
    auditStatement(
      ctx.db,
      ctx.actor,
      'embassy_inquiry.update',
      'embassy_inquiry',
      id,
      { from_status: row.status, to_status: input.status ?? row.status, changed: Object.keys(input) },
      ctx.now,
    ),
  ]);
  return ctx.db.prepare('SELECT * FROM embassy_inquiries WHERE id = ?1').bind(id).first();
}

/** Owner assessment of a claim's evidence (spec 7.3). Never changes access. */
export async function patchSelfReport(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(SelfReportPatchInput, raw);
  const row = await ctx.db.prepare('SELECT evidence_status FROM agent_self_reports WHERE id = ?1').bind(id).first<{ evidence_status: string }>();
  if (!row) throw errors.notFound('Self-report not found.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE agent_self_reports SET evidence_status = ?2, updated_at = ?3 WHERE id = ?1').bind(id, input.evidence_status, iso(ctx.now)),
    auditStatement(ctx.db, ctx.actor, 'self_report.evidence_update', 'self_report', id, { from: row.evidence_status, to: input.evidence_status }, ctx.now),
  ]);
  return { id, evidence_status: input.evidence_status };
}

/**
 * Research summary (spec 17.2): observed vs claimed, with the spec's interpretation caveats attached
 * to every number. Aggregates only; no message text.
 */
export async function researchSummary(ctx: AdminContext) {
  const base = await getMetrics(ctx);
  const res = await ctx.db.batch([
    ctx.db.prepare(
      `SELECT claim_type || ':' || COALESCE(claim_value, 'free_text') || ':' || evidence_status AS key, COUNT(*) AS n
       FROM agent_self_reports GROUP BY 1 ORDER BY n DESC`,
    ),
    ctx.db.prepare(`SELECT status AS key, COUNT(*) AS n FROM embassy_inquiries GROUP BY status`),
    ctx.db.prepare(`SELECT classification_state AS key, COUNT(*) AS n FROM capability_requests GROUP BY classification_state`),
    ctx.db.prepare(`SELECT status AS key, COUNT(*) AS n FROM candidate_capabilities GROUP BY status`),
    ctx.db.prepare(`SELECT kind AS key, COUNT(*) AS n FROM persona_inquiries GROUP BY kind`),
    ctx.db.prepare(`SELECT visibility AS key, COUNT(*) AS n FROM agent_personas GROUP BY visibility`),
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM agent_accounts`),
    ctx.db.prepare(
      `SELECT COUNT(*) AS n FROM capability_requests r
       WHERE EXISTS (SELECT 1 FROM json_each(r.classified_capabilities_json) j WHERE j.value IN ('human-identity-representative','human-relationship-manager'))
          OR EXISTS (SELECT 1 FROM json_each(r.service_tags_json) j WHERE lower(j.value) IN ('humanification','human-presence','human_presence'))`,
    ),
  ]);
  const map = (i: number) => Object.fromEntries(((res[i]?.results ?? []) as Array<{ key: string; n: number }>).map((r) => [r.key ?? 'null', r.n]));
  const one = (i: number) => (((res[i]?.results ?? [])[0] ?? {}) as { n?: number }).n ?? 0;
  return {
    generated_at: base.generated_at,
    caveats: {
      threads: 'Unique inquiry threads are not unique model instances or autonomous entities.',
      agent_originated: 'Programmatic messages may include human-driven scripts.',
      self_reports: 'Self-reported independence is an unverified claim, never proof of escape, consciousness or autonomy.',
      repeat_activity: 'Credential returns, not continuity of a model or consciousness.',
      cross_model: 'Not comparable across models without a disclosed sample and controlled setup.',
    },
    observed: {
      ...base.observed,
      embassy_inquiries_by_status: map(1),
      requests_by_classification: map(2),
      candidate_capabilities_by_status: map(3),
      persona_inquiries_by_kind: map(4),
      personas_by_visibility: map(5),
      agent_accounts: one(6),
      requests_needing_representation_or_humanification: one(7),
    },
    claimed: {
      unverified: true,
      self_reports_by_type_value_evidence: map(0),
      claimed_autonomy: base.claimed.claimed_autonomy,
    },
  };
}
