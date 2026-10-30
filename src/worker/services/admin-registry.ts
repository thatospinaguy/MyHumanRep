import { z } from 'zod';
import { normalizeKey } from '../catalog/capabilities';
import { freeText, shortLabel } from '../schemas/fields';
import { errors } from '../utils/http-errors';
import { iso } from '../utils/time';
import type { AdminContext } from './admin';
import { auditStatement } from './audit';
import { loadRegistry, publicAliases, type CapabilityRow } from './capability-catalog';
import { parseInput } from './context';

const slugSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase words separated by hyphens.').max(64);

export const CapabilityPatchInput = z
  .object({
    display_name: shortLabel('Display name.', 80).optional(),
    summary: freeText('Public summary.', 600).optional(),
    readiness: z.enum(['inquiry_only', 'human_reviewed_inquiry', 'pilot', 'live', 'future']).optional(),
    inquiry_enabled: z.boolean().optional(),
    example_intents: z.array(shortLabel('Example.', 200)).max(10).optional(),
    authorization_requirements: z.array(shortLabel('Requirement.', 200)).max(10).optional(),
    risk_tier: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export const CandidateDecisionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('merge'), capability_slug: slugSchema }).strict(),
  z
    .object({
      action: z.literal('accept'),
      new_slug: slugSchema,
      name: shortLabel('Capability name.', 80),
      summary: freeText('Public summary.', 600),
    })
    .strict(),
  z.object({ action: z.literal('reject') }).strict(),
]);

function arr(json: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function listRegistryAdmin(ctx: AdminContext) {
  const registry = await loadRegistry(ctx.db);
  const counts = await ctx.db
    .prepare(
      `SELECT j.value AS slug, COUNT(*) AS n FROM capability_requests r, json_each(r.classified_capabilities_json) j GROUP BY j.value`,
    )
    .all<{ slug: string; n: number }>();
  const pending = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM candidate_capabilities WHERE status = 'pending'`)
    .first<{ n: number }>();
  const unclassified = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM capability_requests WHERE classification_state = 'unclassified'`)
    .first<{ n: number }>();
  const byCount = new Map(counts.results.map((r) => [r.slug, r.n]));
  return {
    capabilities: registry.capabilities.map((c) => ({
      ...c,
      example_intents: arr(c.example_intents_json),
      deliverables: arr(c.deliverables_json),
      required_skills: arr(c.required_skills_json),
      authorization_requirements: arr(c.authorization_requirements_json),
      request_count: byCount.get(c.slug) ?? 0,
    })),
    aliases: publicAliases(registry.aliases),
    pending_candidates: pending?.n ?? 0,
    unclassified_requests: unclassified?.n ?? 0,
  };
}

export async function patchCapability(ctx: AdminContext, slug: string, raw: unknown) {
  const input = parseInput(CapabilityPatchInput, raw);
  const row = await ctx.db.prepare('SELECT * FROM capabilities WHERE slug = ?1').bind(slug).first<CapabilityRow>();
  if (!row) throw errors.notFound('Capability not found.');
  const sets: string[] = ['updated_at = ?2'];
  const params: unknown[] = [iso(ctx.now)];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = ?${params.length + 1}`);
  };
  if (input.display_name !== undefined) set('display_name', input.display_name);
  if (input.summary !== undefined) set('summary', input.summary);
  if (input.readiness !== undefined) set('readiness', input.readiness);
  if (input.inquiry_enabled !== undefined) set('inquiry_enabled', input.inquiry_enabled ? 1 : 0);
  if (input.example_intents !== undefined) set('example_intents_json', JSON.stringify(input.example_intents));
  if (input.authorization_requirements !== undefined) set('authorization_requirements_json', JSON.stringify(input.authorization_requirements));
  if (input.risk_tier !== undefined) set('risk_tier', input.risk_tier);
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE capabilities SET ${sets.join(', ')} WHERE slug = ?1`).bind(slug, ...params),
    auditStatement(
      ctx.db,
      ctx.actor,
      'capability.update',
      'capability',
      slug,
      { changed: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined), ...(input.readiness ? { readiness: input.readiness } : {}) },
      ctx.now,
    ),
  ]);
  return ctx.db.prepare('SELECT * FROM capabilities WHERE slug = ?1').bind(slug).first<CapabilityRow>();
}

export async function listCandidates(ctx: AdminContext, status: string | undefined) {
  const s = status && ['pending', 'accepted', 'merged', 'rejected'].includes(status) ? status : 'pending';
  const { results } = await ctx.db
    .prepare(
      `SELECT c.*, r.objective, r.problem_statement, r.conversation_id, r.created_at AS request_created_at
       FROM candidate_capabilities c JOIN capability_requests r ON r.id = c.request_id
       WHERE c.status = ?1 ORDER BY c.created_at DESC LIMIT 200`,
    )
    .bind(s)
    .all();
  return { status: s, items: results };
}

function classifyStatement(ctx: AdminContext, requestId: string, slug: string): D1PreparedStatement {
  return ctx.db
    .prepare(
      `UPDATE capability_requests SET classification_state = 'admin_confirmed', updated_at = ?3,
         classified_capabilities_json = (
           SELECT json_group_array(DISTINCT value) FROM (
             SELECT value FROM json_each(capability_requests.classified_capabilities_json) UNION SELECT ?2
           )
         )
       WHERE id = ?1`,
    )
    .bind(requestId, slug, iso(ctx.now));
}

/** Owner review of an unfamiliar request label (spec 5.2). Nothing is published without this step. */
export async function decideCandidate(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(CandidateDecisionInput, raw);
  const cand = await ctx.db
    .prepare('SELECT id, request_id, status, suggested_label FROM candidate_capabilities WHERE id = ?1')
    .bind(id)
    .first<{ id: string; request_id: string; status: string; suggested_label: string | null }>();
  if (!cand) throw errors.notFound('Candidate not found.');
  if (cand.status !== 'pending') throw errors.conflict(`Candidate already ${cand.status}.`, 'already_decided');
  const now = iso(ctx.now);
  const statements: D1PreparedStatement[] = [];
  let slug: string | null = null;

  if (input.action === 'merge') {
    const exists = await ctx.db.prepare('SELECT 1 AS x FROM capabilities WHERE slug = ?1').bind(input.capability_slug).first();
    if (!exists) throw errors.invalid('Unknown capability_slug.', { reason: 'unknown_capability' });
    slug = input.capability_slug;
    statements.push(classifyStatement(ctx, cand.request_id, slug));
  } else if (input.action === 'accept') {
    slug = normalizeKey(input.new_slug);
    const exists = await ctx.db.prepare('SELECT 1 AS x FROM capabilities WHERE slug = ?1').bind(slug).first();
    if (exists) throw errors.conflict('A capability with that slug already exists. Merge into it instead.', 'slug_exists');
    // New capabilities start as inquiry-only: accepting a label never makes a service fulfillable.
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO capabilities (id, slug, number, display_name, summary, readiness, origin, created_at, updated_at)
           VALUES (?1, ?2, NULL, ?3, ?4, 'inquiry_only', 'admin', ?5, ?5)`,
        )
        .bind(`capdef_${slug}`, slug, input.name, input.summary, now),
      classifyStatement(ctx, cand.request_id, slug),
    );
  }
  const status = input.action === 'merge' ? 'merged' : input.action === 'accept' ? 'accepted' : 'rejected';
  statements.push(
    ctx.db
      .prepare(
        `UPDATE candidate_capabilities SET status = ?2, decided_capability_slug = ?3, decided_by = ?4, decided_at = ?5 WHERE id = ?1 AND status = 'pending'`,
      )
      .bind(id, status, slug, ctx.actor, now),
    auditStatement(ctx.db, ctx.actor, `candidate_capability.${input.action}`, 'candidate_capability', id, { capability_slug: slug, request_id: cand.request_id }, ctx.now),
  );
  await ctx.db.batch(statements);
  return { id, status, capability_slug: slug };
}

/** Owner-confirmed classification of a request (replaces the agent's hint-derived match). */
export async function setRequestCapabilities(ctx: AdminContext, requestId: string, slugs: string[]): Promise<D1PreparedStatement> {
  const unique = [...new Set(slugs.map(normalizeKey))];
  if (unique.length > 0) {
    const { results } = await ctx.db
      .prepare(`SELECT slug FROM capabilities WHERE slug IN (${unique.map((_, i) => `?${i + 1}`).join(',')})`)
      .bind(...unique)
      .all<{ slug: string }>();
    const known = new Set(results.map((r) => r.slug));
    const missing = unique.filter((s) => !known.has(s));
    if (missing.length) throw errors.invalid(`Unknown capability slug(s): ${missing.join(', ')}`, { reason: 'unknown_capability' });
  }
  return ctx.db
    .prepare(`UPDATE capability_requests SET classification_state = ?2, classified_capabilities_json = ?3 WHERE id = ?1`)
    .bind(requestId, unique.length ? 'admin_confirmed' : 'unclassified', JSON.stringify(unique.sort()));
}
