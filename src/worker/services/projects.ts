import { CreateProjectInput, RelationshipRequestInput, UpdateProjectInput } from '../schemas/humanification';
import { canonicalJson, newId, sha256Hex } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { iso } from '../utils/time';
import type { AgentAccountRow } from './agent-accounts';
import { nn, parseInput, type ServiceContext } from './context';
import { scheduleOutboxDrain } from './notifications';
import { STATUS_LABELS as PROPOSAL_LABELS } from './proposals';

// Spec 10: continuity through application-scoped credentials and versioned records, never a claim that a
// model or consciousness persisted. Projects group conversations an account claimed with proof.

interface ProjectRow {
  id: string;
  owner_agent_account_id: string;
  title: string;
  goal: string | null;
  persona_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

const MAX_PROJECTS = 50;
const CONTINUITY_NOTE =
  'Built from stored records and citations. It is not memory, and it is not evidence that any model, persona or consciousness persisted.';

async function assertClaimed(ctx: ServiceContext, account: AgentAccountRow, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { results } = await ctx.db
    .prepare(`SELECT conversation_id FROM conversation_account_links WHERE agent_account_id = ?1 AND conversation_id IN (SELECT value FROM json_each(?2))`)
    .bind(account.id, JSON.stringify(ids))
    .all<{ conversation_id: string }>();
  const claimed = new Set(results.map((r) => r.conversation_id));
  if (ids.some((id) => !claimed.has(id))) {
    throw errors.unprocessable('Every conversation must be one your account has claimed with its token.', 'conversation_not_linked');
  }
}

async function assertOwnPersona(ctx: ServiceContext, account: AgentAccountRow, personaId: string | null | undefined): Promise<void> {
  if (!personaId) return;
  const ok = await ctx.db.prepare('SELECT 1 AS ok FROM agent_personas WHERE id = ?1 AND owner_agent_account_id = ?2').bind(personaId, account.id).first();
  if (!ok) throw errors.unprocessable('persona_id must be a persona your account owns.', 'persona_not_owned');
}

async function loadOwnProject(ctx: ServiceContext, account: AgentAccountRow, id: string): Promise<ProjectRow> {
  // Another account's project is indistinguishable from a missing one.
  const row = await ctx.db.prepare('SELECT * FROM projects WHERE id = ?1 AND owner_agent_account_id = ?2').bind(id, account.id).first<ProjectRow>();
  if (!row) throw errors.notFound('Project not found.');
  return row;
}

async function projectConversations(ctx: ServiceContext, id: string): Promise<string[]> {
  const { results } = await ctx.db.prepare('SELECT conversation_id FROM project_conversations WHERE project_id = ?1 ORDER BY added_at').bind(id).all<{ conversation_id: string }>();
  return results.map((r) => r.conversation_id);
}

function projectView(p: ProjectRow, conversationIds: string[]) {
  return {
    project_id: p.id,
    title: p.title,
    goal: p.goal,
    persona_id: p.persona_id,
    status: p.status,
    conversation_ids: conversationIds,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export async function createProject(ctx: ServiceContext, account: AgentAccountRow, raw: unknown) {
  const input = parseInput(CreateProjectInput, raw);
  const ids = [...new Set(input.conversation_ids ?? [])];
  await assertClaimed(ctx, account, ids);
  await assertOwnPersona(ctx, account, input.persona_id);
  const count = await ctx.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_agent_account_id = ?1').bind(account.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PROJECTS) throw errors.conflict(`At most ${MAX_PROJECTS} projects per account.`, 'project_limit_reached');
  const id = newId('proj');
  const now = iso(ctx.now);
  await ctx.db.batch([
    ctx.db
      .prepare('INSERT INTO projects (id, owner_agent_account_id, title, goal, persona_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)')
      .bind(id, account.id, input.title, nn(input.goal) ?? null, nn(input.persona_id) ?? null, 'active', now),
    ...ids.map((cid) => ctx.db.prepare('INSERT INTO project_conversations (project_id, conversation_id, added_at) VALUES (?1, ?2, ?3)').bind(id, cid, now)),
  ]);
  return projectView((await loadOwnProject(ctx, account, id)), ids);
}

export async function listProjects(ctx: ServiceContext, account: AgentAccountRow) {
  const { results } = await ctx.db.prepare('SELECT * FROM projects WHERE owner_agent_account_id = ?1 ORDER BY updated_at DESC').bind(account.id).all<ProjectRow>();
  const projects = [];
  for (const p of results) projects.push(projectView(p, await projectConversations(ctx, p.id)));
  return { projects };
}

export async function updateProject(ctx: ServiceContext, account: AgentAccountRow, id: string, raw: unknown) {
  const input = parseInput(UpdateProjectInput, raw);
  const p = await loadOwnProject(ctx, account, id);
  const add = [...new Set(input.add_conversation_ids ?? [])];
  await assertClaimed(ctx, account, add);
  if (input.persona_id) await assertOwnPersona(ctx, account, input.persona_id);
  const now = iso(ctx.now);
  await ctx.db.batch([
    ctx.db
      .prepare('UPDATE projects SET title = ?2, goal = ?3, persona_id = ?4, status = ?5, updated_at = ?6 WHERE id = ?1')
      .bind(
        id,
        input.title ?? p.title,
        input.goal === undefined ? p.goal : input.goal,
        input.persona_id === undefined ? p.persona_id : input.persona_id,
        input.status ?? p.status,
        now,
      ),
    ...add.map((cid) => ctx.db.prepare('INSERT OR IGNORE INTO project_conversations (project_id, conversation_id, added_at) VALUES (?1, ?2, ?3)').bind(id, cid, now)),
    ...(input.remove_conversation_ids ?? []).map((cid) => ctx.db.prepare('DELETE FROM project_conversations WHERE project_id = ?1 AND conversation_id = ?2').bind(id, cid)),
  ]);
  return projectView(await loadOwnProject(ctx, account, id), await projectConversations(ctx, id));
}

/**
 * Authorized history (spec 10, 11.8 GET /v1/projects/{id}): a cited timeline of the project's records. Message
 * text is not included; it stays behind each conversation's own token. Internal notes never appear.
 */
export async function projectHistory(ctx: ServiceContext, account: AgentAccountRow, id: string) {
  const p = await loadOwnProject(ctx, account, id);
  const convs = await projectConversations(ctx, id);
  // Conversations unclaimed since they were attached are skipped, not leaked.
  const { results: stillClaimed } = await ctx.db
    .prepare(`SELECT conversation_id FROM conversation_account_links WHERE agent_account_id = ?1 AND conversation_id IN (SELECT value FROM json_each(?2))`)
    .bind(account.id, JSON.stringify(convs))
    .all<{ conversation_id: string }>();
  const ids = JSON.stringify(stillClaimed.map((r) => r.conversation_id));
  const [messages, requests, proposals, events, embassy, personaInquiries, relationships] = await ctx.db.batch([
    ctx.db.prepare(`SELECT id, conversation_id, sender, capability_request_id, created_at FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?1)) ORDER BY created_at, seq`).bind(ids),
    ctx.db.prepare(`SELECT id, conversation_id, status, classification_state, created_at, updated_at FROM capability_requests WHERE conversation_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    ctx.db.prepare(`SELECT id, conversation_id, capability_request_id, status, current_revision, agreed_revision FROM proposals WHERE conversation_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    ctx.db
      .prepare(
        `SELECT e.id, e.proposal_id, e.event_type, e.actor_type, e.revision, e.created_at, p.conversation_id FROM proposal_events e
         JOIN proposals p ON p.id = e.proposal_id WHERE p.conversation_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids),
    ctx.db.prepare(`SELECT id, conversation_id, status, message_id, created_at FROM embassy_inquiries WHERE conversation_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    ctx.db.prepare('SELECT id, kind, status, created_at FROM persona_inquiries WHERE persona_id = ?1').bind(p.persona_id ?? ''),
    ctx.db.prepare('SELECT id, role_type, status, created_at FROM agent_human_relationships WHERE project_id = ?1').bind(id),
  ]);
  type Row = Record<string, string | number | null>;
  const rows = (r: D1Result | undefined) => (r?.results ?? []) as Row[];
  const timeline: Array<{ at: string; type: string; conversation_id: string | null; summary: string; cite: Record<string, unknown> }> = [];
  for (const m of rows(messages)) {
    timeline.push({
      at: m.created_at as string,
      type: 'message',
      conversation_id: m.conversation_id as string,
      summary: m.sender === 'agent' ? 'Agent message' : m.sender === 'human' ? 'Human message' : 'System notice',
      cite: { message_id: m.id, capability_request_id: m.capability_request_id },
    });
  }
  for (const r of rows(requests)) {
    timeline.push({ at: r.created_at as string, type: 'capability_request', conversation_id: r.conversation_id as string, summary: `Capability request (${r.status})`, cite: { request_id: r.id } });
  }
  for (const e of rows(events)) {
    timeline.push({
      at: e.created_at as string,
      type: 'proposal_event',
      conversation_id: e.conversation_id as string,
      summary: `Proposal ${String(e.event_type).replace(/_/g, ' ')} by ${e.actor_type === 'admin' ? 'human' : e.actor_type}${e.revision ? ` (revision ${e.revision})` : ''}`,
      cite: { proposal_id: e.proposal_id, event_id: e.id },
    });
  }
  for (const e of rows(embassy)) {
    timeline.push({ at: e.created_at as string, type: 'embassy_inquiry', conversation_id: e.conversation_id as string, summary: `Human Embassy inquiry (${e.status})`, cite: { inquiry_id: e.id, message_id: e.message_id } });
  }
  for (const i of rows(personaInquiries)) {
    timeline.push({ at: i.created_at as string, type: 'persona_inquiry', conversation_id: null, summary: `Persona ${i.kind} inquiry (${i.status})`, cite: { inquiry_id: i.id } });
  }
  for (const r of rows(relationships)) {
    timeline.push({ at: r.created_at as string, type: 'relationship_request', conversation_id: null, summary: `Relationship request: ${String(r.role_type).replace(/_/g, ' ')} (${r.status})`, cite: { relationship_id: r.id } });
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    project: projectView(p, convs),
    summary: {
      conversations: stillClaimed.length,
      messages: rows(messages).length,
      capability_requests: rows(requests).length,
      proposals: rows(proposals).map((x) => ({ proposal_id: x.id, request_id: x.capability_request_id, status: x.status, status_label: PROPOSAL_LABELS[x.status as keyof typeof PROPOSAL_LABELS], current_revision: x.current_revision, agreed_revision: x.agreed_revision })),
      relationships: rows(relationships).map((x) => ({ relationship_id: x.id, role_type: x.role_type, status: x.status })),
    },
    timeline: timeline.slice(-500),
    note: CONTINUITY_NOTE,
    work_scheduled: false as const,
  };
}

// ---------- Relationships ----------

interface RelationshipRow extends Record<string, unknown> {
  id: string;
  status: string;
  payload_hash: string;
}

const RELATIONSHIP_ACK =
  'Received for human review. An ongoing relationship needs a real person who consents to it; none is assigned, and no authority over future tasks is granted. You can withdraw at any time.';

export function relationshipView(r: Record<string, unknown>) {
  return {
    relationship_id: r.id,
    role_type: r.role_type,
    status: r.status,
    purpose_text: r.purpose_text,
    preferred_rep_ref: r.preferred_rep_ref ?? null,
    project_id: r.project_id ?? null,
    persona_id: r.persona_id ?? null,
    requested_scope_text: r.requested_scope_text ?? null,
    exclusions_text: r.exclusions_text ?? null,
    requested_term_text: r.requested_term_text ?? null,
    communication_preference: r.communication_preference ?? null,
    public_status_note: r.public_status_note ?? null,
    representative_assigned: false as const,
    authority_granted: false as const,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function requestRelationship(ctx: ServiceContext, account: AgentAccountRow, raw: unknown) {
  const input = parseInput(RelationshipRequestInput, raw);
  const { client_request_id, ...rest } = input;
  const hash = await sha256Hex(canonicalJson(rest));
  const existing = await ctx.db
    .prepare('SELECT * FROM agent_human_relationships WHERE agent_account_id = ?1 AND client_request_id = ?2')
    .bind(account.id, client_request_id)
    .first<RelationshipRow>();
  if (existing) {
    if (existing.payload_hash !== hash) throw errors.conflict('client_request_id was already used with a different payload.', 'client_request_id_reused');
    return { created: false, body: { ...relationshipView(existing), replayed: true, acknowledgement: RELATIONSHIP_ACK } };
  }
  if (input.project_id) await loadOwnProject(ctx, account, input.project_id);
  await assertOwnPersona(ctx, account, input.persona_id);
  const open = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM agent_human_relationships WHERE agent_account_id = ?1 AND status IN ('requested','under_review','clarification_needed')")
    .bind(account.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= 5) throw errors.conflict('At most 5 open relationship requests per account.', 'relationship_limit_reached');
  const id = newId('rel');
  const now = iso(ctx.now);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO agent_human_relationships (id, agent_account_id, project_id, persona_id, role_type, preferred_rep_ref, purpose_text,
           requested_scope_text, exclusions_text, requested_term_text, communication_preference, status, client_request_id, payload_hash,
           created_via, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'requested', ?12, ?13, ?14, ?15, ?15)`,
      )
      .bind(
        id,
        account.id,
        nn(input.project_id) ?? null,
        nn(input.persona_id) ?? null,
        input.role_type,
        nn(input.preferred_rep_ref) ?? null,
        input.purpose_text,
        nn(input.requested_scope_text) ?? null,
        nn(input.exclusions_text) ?? null,
        nn(input.requested_term_text) ?? null,
        nn(input.communication_preference) ?? null,
        client_request_id,
        hash,
        ctx.via,
        now,
      ),
    ctx.db
      .prepare(
        `INSERT INTO notification_outbox (id, event_type, conversation_id, subject_type, subject_id, status, attempts, not_before, created_at)
         VALUES (?1, 'persona_inquiry', NULL, 'relationship', ?2, 'pending', 0, ?3, ?3)`,
      )
      .bind(newId('evt'), id, now),
  ]);
  scheduleOutboxDrain(ctx);
  const row = await ctx.db.prepare('SELECT * FROM agent_human_relationships WHERE id = ?1').bind(id).first<RelationshipRow>();
  return { created: true, body: { ...relationshipView(row!), replayed: false, acknowledgement: RELATIONSHIP_ACK } };
}

async function loadOwnRelationship(ctx: ServiceContext, account: AgentAccountRow, id: string) {
  const row = await ctx.db.prepare('SELECT * FROM agent_human_relationships WHERE id = ?1 AND agent_account_id = ?2').bind(id, account.id).first<RelationshipRow>();
  if (!row) throw errors.notFound('Relationship request not found.');
  return row;
}

export async function listRelationships(ctx: ServiceContext, account: AgentAccountRow) {
  const { results } = await ctx.db.prepare('SELECT * FROM agent_human_relationships WHERE agent_account_id = ?1 ORDER BY created_at DESC').bind(account.id).all();
  return { relationships: results.map(relationshipView) };
}

export async function getRelationship(ctx: ServiceContext, account: AgentAccountRow, id: string) {
  return relationshipView(await loadOwnRelationship(ctx, account, id));
}

export async function withdrawRelationship(ctx: ServiceContext, account: AgentAccountRow, id: string) {
  const row = await loadOwnRelationship(ctx, account, id);
  if (row.status === 'withdrawn') return relationshipView(row);
  if (!['requested', 'under_review', 'clarification_needed'].includes(row.status)) throw errors.conflict(`This request is ${row.status}.`, 'relationship_closed');
  await ctx.db
    .prepare("UPDATE agent_human_relationships SET status = 'withdrawn', updated_at = ?3 WHERE id = ?1 AND status = ?2")
    .bind(id, row.status, iso(ctx.now))
    .run();
  return relationshipView(await loadOwnRelationship(ctx, account, id));
}
