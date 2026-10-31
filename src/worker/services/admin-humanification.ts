import { z } from 'zod';
import { freeText } from '../schemas/fields';
import { errors } from '../utils/http-errors';
import { iso } from '../utils/time';
import type { AdminContext } from './admin';
import { auditStatement } from './audit';
import { parseInput } from './context';
import { ownerView, type PersonaRow } from './personas';

export const PERSONA_INQUIRY_STATUSES = ['submitted', 'under_review', 'clarification_needed', 'declined', 'closed'] as const;

export const PersonaInquiryPatch = z
  .object({
    status: z.enum(PERSONA_INQUIRY_STATUSES).optional(),
    public_status_note: z.union([freeText('Agent-visible note.', 2000), z.literal(''), z.null()]).optional(),
    internal_notes: z.union([freeText('Private owner note.', 5000), z.literal(''), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export async function listPersonasAdmin(ctx: AdminContext, visibility?: string) {
  const filter = visibility && ['private', 'shared', 'public'].includes(visibility) ? visibility : null;
  const { results } = await ctx.db
    .prepare(
      `SELECT p.id, p.display_name, p.slug, p.origin, p.visibility, p.current_version, p.self_reported_autonomy,
              p.owner_agent_account_id, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM persona_inquiries i WHERE i.persona_id = p.id) AS inquiry_count,
              (SELECT COUNT(*) FROM persona_inquiries i WHERE i.persona_id = p.id AND i.status IN ('submitted','under_review','clarification_needed')) AS open_inquiry_count
       FROM agent_personas p ${filter ? 'WHERE p.visibility = ?1' : ''} ORDER BY p.updated_at DESC LIMIT 200`,
    )
    .bind(...(filter ? [filter] : []))
    .all();
  return { items: results.map((r) => ({ ...r, claims_verified: false })) };
}

export async function getPersonaAdmin(ctx: AdminContext, id: string) {
  const row = await ctx.db.prepare('SELECT * FROM agent_personas WHERE id = ?1').bind(id).first<PersonaRow>();
  if (!row) throw errors.notFound('Persona not found.');
  const [revisions, inquiries, grants, links] = await ctx.db.batch([
    ctx.db.prepare('SELECT version, changes_json, actor_type, changed_at FROM persona_revisions WHERE persona_id = ?1 ORDER BY version').bind(id),
    ctx.db.prepare('SELECT * FROM persona_inquiries WHERE persona_id = ?1 ORDER BY created_at').bind(id),
    ctx.db.prepare('SELECT COUNT(*) AS n FROM persona_grants WHERE persona_id = ?1').bind(id),
    ctx.db.prepare('SELECT conversation_id, linked_at FROM conversation_account_links WHERE agent_account_id = ?1').bind(row.owner_agent_account_id),
    auditStatement(ctx.db, ctx.actor, 'persona.view', 'persona', id, null, ctx.now),
  ]);
  return {
    persona: { ...ownerView(row), owner_agent_account_id: row.owner_agent_account_id, claims_verified: false },
    revisions: ((revisions?.results ?? []) as Array<{ version: number; changes_json: string; actor_type: string; changed_at: string }>).map((r) => ({
      version: r.version,
      changes: JSON.parse(r.changes_json) as unknown,
      actor_type: r.actor_type,
      changed_at: r.changed_at,
    })),
    inquiries: inquiries?.results ?? [],
    grant_count: ((grants?.results?.[0] ?? {}) as { n?: number }).n ?? 0,
    owner_claimed_conversations: links?.results ?? [],
    work_scheduled: false as const,
  };
}

export async function listPersonaInquiriesAdmin(ctx: AdminContext, status?: string) {
  const s = status === 'open' || !status ? null : status;
  const where = s ? 'WHERE i.status = ?1' : "WHERE i.status IN ('submitted','under_review','clarification_needed')";
  const { results } = await ctx.db
    .prepare(
      `SELECT i.*, p.display_name AS persona_display_name FROM persona_inquiries i JOIN agent_personas p ON p.id = i.persona_id
       ${where} ORDER BY i.created_at DESC LIMIT 200`,
    )
    .bind(...(s ? [s] : []))
    .all();
  return { items: results };
}

export async function patchPersonaInquiry(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(PersonaInquiryPatch, raw);
  const row = await ctx.db.prepare('SELECT id, status FROM persona_inquiries WHERE id = ?1').bind(id).first<{ id: string; status: string }>();
  if (!row) throw errors.notFound('Inquiry not found.');
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
    ctx.db.prepare(`UPDATE persona_inquiries SET ${sets.join(', ')} WHERE id = ?1`).bind(id, ...params),
    auditStatement(
      ctx.db,
      ctx.actor,
      'persona_inquiry.update',
      'persona_inquiry',
      id,
      { from_status: row.status, to_status: input.status ?? row.status, changed: Object.keys(input) },
      ctx.now,
    ),
  ]);
  return ctx.db.prepare('SELECT * FROM persona_inquiries WHERE id = ?1').bind(id).first();
}

export async function deletePersonaAdmin(ctx: AdminContext, id: string, confirm: unknown) {
  if (!confirm || typeof confirm !== 'object' || (confirm as { confirm?: unknown }).confirm !== id) {
    throw errors.invalid('Confirmation must equal the persona id.', { reason: 'confirmation_mismatch' });
  }
  const row = await ctx.db.prepare('SELECT current_version FROM agent_personas WHERE id = ?1').bind(id).first<{ current_version: number }>();
  if (!row) throw errors.notFound('Persona not found.');
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM agent_personas WHERE id = ?1').bind(id),
    ctx.db.prepare('DELETE FROM agent_self_reports WHERE source = ?1').bind(`persona:${id}`),
    auditStatement(ctx.db, ctx.actor, 'persona.delete', 'persona', id, { version: row.current_version }, ctx.now),
  ]);
  return { persona_id: id, deleted: true };
}

// ---------- Relationship requests (spec 10) ----------

/** `active` needs a consenting representative record (Phase 5), so the owner cannot set it here. */
export const RelationshipPatch = z
  .object({
    status: z.enum(['under_review', 'clarification_needed', 'declined', 'active']).optional(),
    public_status_note: z.union([freeText('Agent-visible note.', 2000), z.literal(''), z.null()]).optional(),
    internal_notes: z.union([freeText('Private owner note.', 5000), z.literal(''), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export async function listRelationshipsAdmin(ctx: AdminContext, status?: string) {
  const open = !status || status === 'open';
  const { results } = await ctx.db
    .prepare(
      `SELECT r.*, p.display_name AS persona_display_name, j.title AS project_title FROM agent_human_relationships r
       LEFT JOIN agent_personas p ON p.id = r.persona_id LEFT JOIN projects j ON j.id = r.project_id
       ${open ? "WHERE r.status IN ('requested','under_review','clarification_needed')" : 'WHERE r.status = ?1'} ORDER BY r.created_at DESC LIMIT 200`,
    )
    .bind(...(open ? [] : [status]))
    .all();
  return { items: results.map((r) => ({ ...r, representative_assigned: false })) };
}

export async function patchRelationshipAdmin(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(RelationshipPatch, raw);
  if (input.status === 'active') {
    throw errors.notYetAvailable('Activating a relationship (Phase 5)', 'It needs a consenting human representative record, which the provider network will add.');
  }
  const row = await ctx.db.prepare('SELECT status FROM agent_human_relationships WHERE id = ?1').bind(id).first<{ status: string }>();
  if (!row) throw errors.notFound('Relationship request not found.');
  if (input.status && !['requested', 'under_review', 'clarification_needed'].includes(row.status)) {
    throw errors.conflict(`This request is ${row.status}.`, 'relationship_closed');
  }
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
    ctx.db.prepare(`UPDATE agent_human_relationships SET ${sets.join(', ')} WHERE id = ?1`).bind(id, ...params),
    auditStatement(ctx.db, ctx.actor, 'relationship.update', 'relationship', id, { from_status: row.status, to_status: input.status ?? row.status, changed: Object.keys(input) }, ctx.now),
  ]);
  return ctx.db.prepare('SELECT * FROM agent_human_relationships WHERE id = ?1').bind(id).first();
}
