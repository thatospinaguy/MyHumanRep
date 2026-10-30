import type { z } from 'zod';
import { normalizeKey } from '../catalog/capabilities';
import {
  CreatePersonaInput,
  EmbodimentInquiryInput,
  GrantInput,
  MediaBriefInput,
  PUBLIC_ELIGIBLE_FIELDS,
  RepresentationInquiryInput,
  UpdatePersonaInput,
  type PublicField,
} from '../schemas/humanification';
import { canonicalJson, newId, sha256Hex } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { iso } from '../utils/time';
import { assertConversationLinked, isAccountId, type AgentAccountRow } from './agent-accounts';
import { auditStatement } from './audit';
import { nn, parseInput, type ServiceContext } from './context';
import { requireFlag } from './feature-flags';
import { scheduleOutboxDrain } from './notifications';
import { normalizeAutonomy, selfReportStatement } from './self-reports';

export const PERSONA_NOTICE =
  'A persona is an original created identity. It is not a verified natural person, legal identity, payment authority or credential, and its ID grants no access to anything.';

export interface PersonaRow {
  id: string;
  owner_agent_account_id: string;
  slug: string;
  display_name: string;
  origin: string;
  biography: string | null;
  character_backstory: string | null;
  communication_style: string | null;
  language: string | null;
  pronouns: string | null;
  interests_json: string;
  preferences: string | null;
  persona_objective: string | null;
  intended_audiences_json: string;
  intended_uses_json: string;
  appearance_brief: string | null;
  voice_brief: string | null;
  self_reported_autonomy: string | null;
  preferred_performer_note: string | null;
  visibility: 'private' | 'shared' | 'public';
  public_fields_json: string;
  current_version: number;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

const PERSONA_ID_PATTERN = /^per_[A-Za-z0-9_-]{22}$/;

/** Column <-> API field mapping for editable persona fields. */
const COLUMNS: Record<string, { column: string; json?: boolean }> = {
  display_name: { column: 'display_name' },
  slug: { column: 'slug' },
  origin: { column: 'origin' },
  biography: { column: 'biography' },
  character_backstory: { column: 'character_backstory' },
  communication_style: { column: 'communication_style' },
  language: { column: 'language' },
  pronouns: { column: 'pronouns' },
  interests: { column: 'interests_json', json: true },
  preferences: { column: 'preferences' },
  persona_objective: { column: 'persona_objective' },
  intended_audiences: { column: 'intended_audiences_json', json: true },
  intended_uses: { column: 'intended_uses_json', json: true },
  appearance_brief: { column: 'appearance_brief' },
  voice_brief: { column: 'voice_brief' },
  self_reported_autonomy: { column: 'self_reported_autonomy' },
  preferred_performer_note: { column: 'preferred_performer_note' },
  visibility: { column: 'visibility' },
  public_fields: { column: 'public_fields_json', json: true },
};

function arr(json: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function fieldValue(row: PersonaRow, field: string): unknown {
  const map = COLUMNS[field];
  if (!map) return undefined;
  const raw = (row as unknown as Record<string, unknown>)[map.column];
  return map.json ? arr(raw as string) : raw;
}

/** Owner view: everything, plus explicit non-authority metadata (spec 6.6). */
export function ownerView(row: PersonaRow) {
  return {
    persona_id: row.id,
    version: row.current_version,
    display_name: row.display_name,
    slug: row.slug,
    origin: row.origin,
    biography: row.biography,
    character_backstory: row.character_backstory,
    communication_style: row.communication_style,
    language: row.language,
    pronouns: row.pronouns,
    interests: arr(row.interests_json),
    preferences: row.preferences,
    persona_objective: row.persona_objective,
    intended_audiences: arr(row.intended_audiences_json),
    intended_uses: arr(row.intended_uses_json),
    appearance_brief: row.appearance_brief,
    voice_brief: row.voice_brief,
    self_reported_autonomy: row.self_reported_autonomy,
    preferred_performer_note: row.preferred_performer_note,
    visibility: row.visibility,
    public_fields: arr(row.public_fields_json),
    schema_version: row.schema_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    identity: { verified_natural_person: false, legal_identity: false, payment_authority: false, credential: false },
    notice: PERSONA_NOTICE,
  };
}

/** Shared/public view: only display_name, slug and owner-selected presentation fields. Never the autonomy claim. */
export function presentationView(row: PersonaRow) {
  const fields = arr(row.public_fields_json).filter((f): f is PublicField => (PUBLIC_ELIGIBLE_FIELDS as readonly string[]).includes(f));
  return {
    persona_id: row.id,
    display_name: row.display_name,
    slug: row.slug,
    origin: row.origin,
    visibility: row.visibility,
    ...Object.fromEntries(fields.map((f) => [f, fieldValue(row, f)])),
    identity: { verified_natural_person: false, legal_identity: false },
    notice: PERSONA_NOTICE,
  };
}

async function loadPersona(ctx: ServiceContext, id: string): Promise<PersonaRow | null> {
  if (!PERSONA_ID_PATTERN.test(id)) return null;
  return ctx.db.prepare('SELECT * FROM agent_personas WHERE id = ?1').bind(id).first<PersonaRow>();
}

const personaNotFound = () => errors.notFound('Persona not found.');

/** Owner-only access. Non-owners get 404 so private persona IDs cannot be probed (T-036). */
async function loadOwned(ctx: ServiceContext, account: AgentAccountRow, id: string): Promise<PersonaRow> {
  const row = await loadPersona(ctx, id);
  if (!row || row.owner_agent_account_id !== account.id) throw personaNotFound();
  return row;
}

async function isGrantee(ctx: ServiceContext, personaId: string, accountId: string): Promise<boolean> {
  return !!(await ctx.db
    .prepare('SELECT 1 AS ok FROM persona_grants WHERE persona_id = ?1 AND grantee_account_id = ?2')
    .bind(personaId, accountId)
    .first());
}

function revisionStatement(ctx: ServiceContext, personaId: string, version: number, changes: Record<string, unknown>, actorId: string) {
  return ctx.db
    .prepare(
      `INSERT INTO persona_revisions (id, persona_id, version, changes_json, actor_type, actor_id, changed_at)
       VALUES (?1, ?2, ?3, ?4, 'agent_account', ?5, ?6)`,
    )
    .bind(newId('prev'), personaId, version, JSON.stringify(changes), actorId, iso(ctx.now));
}

function toColumnValue(field: string, value: unknown): unknown {
  if (value === null || value === undefined) return COLUMNS[field]?.json ? '[]' : null;
  return COLUMNS[field]?.json ? JSON.stringify(value) : value;
}

export async function createPersona(ctx: ServiceContext, account: AgentAccountRow, raw: unknown) {
  const input = parseInput(CreatePersonaInput, raw);
  const id = newId('per');
  const slug = nn(input.slug) ?? (normalizeKey(input.display_name) || 'persona');
  const taken = await ctx.db
    .prepare('SELECT 1 AS x FROM agent_personas WHERE owner_agent_account_id = ?1 AND slug = ?2')
    .bind(account.id, slug)
    .first();
  if (taken) throw errors.conflict('You already have a persona with this slug. Choose another slug.', 'slug_taken');
  const autonomy = input.self_reported_autonomy ? normalizeAutonomy(input.self_reported_autonomy) : null;

  const values: Record<string, unknown> = {};
  for (const field of Object.keys(COLUMNS)) {
    const v = (input as Record<string, unknown>)[field];
    if (v !== undefined && v !== null) values[field] = v;
  }
  values.slug = slug;
  values.visibility = values.visibility ?? 'private';
  values.origin = values.origin ?? 'original_ai_created_persona';
  if (autonomy) values.self_reported_autonomy = autonomy.claim;

  const fields = Object.keys(values);
  const cols = fields.map((f) => COLUMNS[f]!.column);
  const now = iso(ctx.now);
  const statements = [
    ctx.db
      .prepare(
        `INSERT INTO agent_personas (id, owner_agent_account_id, ${cols.join(', ')}, current_version, schema_version, created_at, updated_at)
         VALUES (?1, ?2, ${fields.map((_, i) => `?${i + 3}`).join(', ')}, 1, 1, ?${fields.length + 3}, ?${fields.length + 3})`,
      )
      .bind(id, account.id, ...fields.map((f) => toColumnValue(f, values[f])), now),
    revisionStatement(ctx, id, 1, { created: Object.fromEntries(fields.map((f) => [f, values[f]])) }, account.id),
  ];
  if (autonomy && autonomy.claim !== 'not_stated') {
    statements.push(
      selfReportStatement(
        ctx.db,
        { conversationId: null, agentAccountId: account.id, claimType: 'autonomy', value: autonomy.claim, text: autonomy.text, source: `persona:${id}` },
        ctx.now,
      ),
    );
  }
  await ctx.db.batch(statements);
  return ownerView((await loadPersona(ctx, id))!);
}

export async function updatePersona(ctx: ServiceContext, account: AgentAccountRow, id: string, raw: unknown) {
  const input = parseInput(UpdatePersonaInput, raw);
  const row = await loadOwned(ctx, account, id);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of Object.keys(COLUMNS)) {
    let v = (input as Record<string, unknown>)[field];
    if (v === undefined) continue;
    if (field === 'display_name' && v === null) throw errors.invalid('display_name cannot be removed.', { reason: 'validation_failed' });
    if (field === 'slug' && v === null) continue;
    if (field === 'self_reported_autonomy' && typeof v === 'string') v = normalizeAutonomy(v).claim;
    if (field === 'visibility' && v === null) v = 'private';
    const before = fieldValue(row, field);
    if (canonicalJson(before ?? null) === canonicalJson(v ?? (COLUMNS[field]!.json ? [] : null))) continue;
    changes[field] = { from: before ?? null, to: v ?? null };
    params.push(toColumnValue(field, v));
    sets.push(`${COLUMNS[field]!.column} = ?${params.length + 3}`);
  }
  if (input.slug) {
    const taken = await ctx.db
      .prepare('SELECT 1 AS x FROM agent_personas WHERE owner_agent_account_id = ?1 AND slug = ?2 AND id != ?3')
      .bind(account.id, input.slug, id)
      .first();
    if (taken) throw errors.conflict('You already have a persona with this slug.', 'slug_taken');
  }
  if (sets.length === 0) return { ...ownerView(row), changed: false };
  const version = row.current_version + 1;
  const results = await ctx.db.batch([
    // Optimistic version check: a concurrent edit makes this a no-op and we report a conflict.
    ctx.db
      .prepare(
        `UPDATE agent_personas SET ${sets.join(', ')}, current_version = ?2, updated_at = ?3
         WHERE id = ?1 AND current_version = ?${params.length + 4}`,
      )
      .bind(id, version, iso(ctx.now), ...params, row.current_version),
    ctx.db
      .prepare(
        `INSERT INTO persona_revisions (id, persona_id, version, changes_json, actor_type, actor_id, changed_at)
         SELECT ?1, ?2, ?3, ?4, 'agent_account', ?5, ?6 WHERE EXISTS (SELECT 1 FROM agent_personas WHERE id = ?2 AND current_version = ?3)`,
      )
      .bind(newId('prev'), id, version, JSON.stringify(changes), account.id, iso(ctx.now)),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw errors.conflict('The persona changed concurrently. Read it again and retry.', 'version_conflict');
  return { ...ownerView((await loadPersona(ctx, id))!), changed: true };
}

/** Read by ID with visibility rules (spec 11.7). Unauthenticated callers may read public personas only. */
export async function readPersona(ctx: ServiceContext, account: AgentAccountRow | null, id: string) {
  await requireFlag(ctx.db, 'persona_studio_enabled', 'Personas');
  const row = await loadPersona(ctx, id);
  if (!row) throw personaNotFound();
  if (account && row.owner_agent_account_id === account.id) return ownerView(row);
  if (row.visibility === 'public') return presentationView(row);
  if (row.visibility === 'shared' && account && (await isGrantee(ctx, id, account.id))) return presentationView(row);
  throw personaNotFound();
}

export async function listPersonas(ctx: ServiceContext, account: AgentAccountRow) {
  const [own, shared] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM agent_personas WHERE owner_agent_account_id = ?1 ORDER BY updated_at DESC').bind(account.id),
    ctx.db
      .prepare(
        `SELECT p.* FROM agent_personas p JOIN persona_grants g ON g.persona_id = p.id
         WHERE g.grantee_account_id = ?1 AND p.visibility IN ('shared','public') ORDER BY p.updated_at DESC`,
      )
      .bind(account.id),
  ]);
  return {
    own: ((own?.results ?? []) as PersonaRow[]).map(ownerView),
    shared_with_me: ((shared?.results ?? []) as PersonaRow[]).map(presentationView),
  };
}

export async function personaHistory(ctx: ServiceContext, account: AgentAccountRow, id: string) {
  const row = await loadPersona(ctx, id);
  if (!row) throw personaNotFound();
  const owner = row.owner_agent_account_id === account.id;
  if (!owner && !(row.visibility !== 'private' && (await isGrantee(ctx, id, account.id)))) throw personaNotFound();
  const { results } = await ctx.db
    .prepare('SELECT version, changes_json, actor_type, changed_at FROM persona_revisions WHERE persona_id = ?1 ORDER BY version ASC')
    .bind(id)
    .all<{ version: number; changes_json: string; actor_type: string; changed_at: string }>();
  const visible = new Set<string>(['display_name', 'slug', 'visibility', ...arr(row.public_fields_json)]);
  return {
    persona_id: id,
    current_version: row.current_version,
    revisions: results.map((r) => {
      const changes = JSON.parse(r.changes_json) as Record<string, unknown>;
      const body = 'created' in changes ? (changes.created as Record<string, unknown>) : changes;
      // Grantees see which fields changed, with values only for presentation fields.
      const filtered = owner ? body : Object.fromEntries(Object.entries(body).map(([k, v]) => [k, visible.has(k) ? v : '(private)']));
      return { version: r.version, kind: 'created' in changes ? 'created' : 'updated', changes: filtered, actor_type: r.actor_type, changed_at: r.changed_at };
    }),
  };
}

export async function deletePersona(ctx: ServiceContext, account: AgentAccountRow, id: string) {
  const row = await loadOwned(ctx, account, id);
  await ctx.db.batch([
    // Cascades revisions, grants and inquiries. No public asset remains (no uploads exist).
    ctx.db.prepare('DELETE FROM agent_personas WHERE id = ?1 AND owner_agent_account_id = ?2').bind(id, account.id),
    // Self-reports made through the persona are not FK-linked to it; remove them too.
    ctx.db.prepare('DELETE FROM agent_self_reports WHERE source = ?1').bind(`persona:${id}`),
    auditStatement(ctx.db, `agent_account:${account.id}`, 'persona.delete', 'persona', id, { version: row.current_version }, ctx.now),
  ]);
  return { persona_id: id, deleted: true };
}

export async function grantPersona(ctx: ServiceContext, account: AgentAccountRow, id: string, raw: unknown) {
  const input = parseInput(GrantInput, raw);
  await loadOwned(ctx, account, id);
  if (input.grantee_account_id === account.id) throw errors.invalid('You already own this persona.', { reason: 'self_grant' });
  const grantee = isAccountId(input.grantee_account_id)
    ? await ctx.db.prepare("SELECT 1 AS ok FROM agent_accounts WHERE id = ?1 AND status = 'active'").bind(input.grantee_account_id).first()
    : null;
  if (!grantee) throw errors.invalid('Unknown grantee_account_id.', { reason: 'unknown_account' });
  await ctx.db
    .prepare('INSERT OR IGNORE INTO persona_grants (persona_id, grantee_account_id, granted_at) VALUES (?1, ?2, ?3)')
    .bind(id, input.grantee_account_id, iso(ctx.now))
    .run();
  return { persona_id: id, grantee_account_id: input.grantee_account_id, granted: true, note: 'Grants affect visibility only when the persona is shared or public.' };
}

export async function revokeGrant(ctx: ServiceContext, account: AgentAccountRow, id: string, grantee: string) {
  await loadOwned(ctx, account, id);
  await ctx.db.prepare('DELETE FROM persona_grants WHERE persona_id = ?1 AND grantee_account_id = ?2').bind(id, grantee).run();
  return { persona_id: id, grantee_account_id: grantee, granted: false };
}

/**
 * Continuity summary built only from stored records (spec 6.2.7, T-046). Deterministic, cited,
 * and explicitly not memory, experience or proof of identity.
 */
export async function continuitySummary(ctx: ServiceContext, account: AgentAccountRow, id: string) {
  const row = await loadOwned(ctx, account, id);
  const [revisions, inquiries, links] = await ctx.db.batch([
    ctx.db.prepare('SELECT version, changes_json, changed_at FROM persona_revisions WHERE persona_id = ?1 ORDER BY version').bind(id),
    ctx.db.prepare('SELECT id, kind, role_type, media_type, status, created_at FROM persona_inquiries WHERE persona_id = ?1 ORDER BY created_at').bind(id),
    ctx.db.prepare('SELECT conversation_id, linked_at FROM conversation_account_links WHERE agent_account_id = ?1 ORDER BY linked_at').bind(account.id),
  ]);
  const revs = (revisions?.results ?? []) as Array<{ version: number; changes_json: string; changed_at: string }>;
  const inqs = (inquiries?.results ?? []) as Array<{ id: string; kind: string; role_type: string | null; media_type: string | null; status: string; created_at: string }>;
  const convs = (links?.results ?? []) as Array<{ conversation_id: string; linked_at: string }>;
  const changedFields = new Set<string>();
  for (const r of revs.slice(1)) Object.keys(JSON.parse(r.changes_json) as object).forEach((k) => changedFields.add(k));
  const lines = [
    `${row.display_name} is an original persona created ${row.created_at.slice(0, 10)} (version ${row.current_version}).`,
    revs.length > 1 ? `It was revised ${revs.length - 1} time(s); fields changed: ${[...changedFields].sort().join(', ')}.` : 'It has not been revised.',
    inqs.length
      ? `${inqs.length} human embodiment/representation/media inquiry(ies): ${inqs.map((i) => `${i.kind}${i.role_type ? ` (${i.role_type})` : i.media_type ? ` (${i.media_type})` : ''}: ${i.status}`).join('; ')}.`
      : 'No human embodiment or representation has been requested.',
    `The owning account has claimed ${convs.length} conversation(s).`,
  ];
  return {
    persona_id: id,
    summary_type: 'generated_from_stored_records',
    generated_at: iso(ctx.now),
    is_memory: false,
    is_proof_of_identity: false,
    is_proof_of_experience: false,
    summary: lines.join(' '),
    sources: [
      ...revs.map((r) => ({ type: 'persona_revision', version: r.version, at: r.changed_at })),
      ...inqs.map((i) => ({ type: 'persona_inquiry', id: i.id, at: i.created_at })),
      ...convs.map((c) => ({ type: 'conversation_link', conversation_id: c.conversation_id, at: c.linked_at })),
    ],
  };
}

// ---------- Embodiment / representation / media-brief inquiries ----------

type InquiryKind = 'embodiment' | 'representation' | 'media_brief';
const INQUIRY_SCHEMAS = {
  embodiment: EmbodimentInquiryInput,
  representation: RepresentationInquiryInput,
  media_brief: MediaBriefInput,
} as const;

const INQUIRY_MESSAGE =
  'Inquiry received for human review. No performer or representative has been contacted, assigned, agreed or paid. Any engagement needs that person\'s consent and a scoped agreement.';

function inquiryView(r: Record<string, unknown>) {
  return {
    inquiry_id: r.id,
    persona_id: r.persona_id,
    kind: r.kind,
    role_type: r.role_type ?? null,
    media_type: r.media_type ?? null,
    context: r.context ?? null,
    status: r.status,
    public_status_note: r.public_status_note ?? null,
    conversation_id: r.conversation_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    binding_commitment: false,
    performer_assigned: false,
  };
}

export async function createPersonaInquiry(ctx: ServiceContext, account: AgentAccountRow, personaId: string, kind: InquiryKind, raw: unknown) {
  await requireFlag(ctx.db, 'embodiment_inquiries_enabled', 'Persona embodiment and representation inquiries');
  const input = parseInput(INQUIRY_SCHEMAS[kind], raw) as z.infer<(typeof INQUIRY_SCHEMAS)['embodiment']> &
    Partial<z.infer<typeof MediaBriefInput>>;
  const persona = await loadOwned(ctx, account, personaId);
  const conversationId = nn(input.conversation_id) ?? null;
  if (conversationId) await assertConversationLinked(ctx, account.id, conversationId);

  const normalized = {
    kind,
    role_type: kind === 'media_brief' ? null : (input.role_type ?? null),
    media_type: kind === 'media_brief' ? (input.media_type ?? null) : null,
    context: nn(input.context) ?? null,
    audience_text: nn(input.audience_text) ?? null,
    scope_text: nn(input.scope_text) ?? null,
    exclusions_text: nn(input.exclusions_text) ?? null,
    channels_text: nn(input.channels_text) ?? null,
    location_text: nn(input.location_text) ?? null,
    timing_text: nn(input.timing_text) ?? null,
    brief_text: nn(input.brief_text) ?? null,
    disclosure_preference: nn(input.disclosure_preference) ?? null,
    budget_amount_minor: nn(input.budget)?.amount_minor ?? null,
    budget_currency: nn(input.budget)?.currency ?? null,
    preferred_performer_note: nn(input.preferred_performer_note) ?? null,
    conversation_id: conversationId,
  };
  const hash = await sha256Hex(canonicalJson(normalized));
  const existing = await ctx.db
    .prepare('SELECT * FROM persona_inquiries WHERE persona_id = ?1 AND client_request_id = ?2')
    .bind(personaId, input.client_request_id)
    .first<Record<string, unknown>>();
  if (existing) {
    if (existing.payload_hash !== hash) throw errors.conflict('client_request_id was already used with a different payload.', 'client_request_id_reused');
    return { created: false, body: { ...inquiryView(existing), replayed: true, message: INQUIRY_MESSAGE } };
  }
  const id = newId('pinq');
  const now = iso(ctx.now);
  const cols = Object.keys(normalized);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO persona_inquiries (id, persona_id, owner_agent_account_id, client_request_id, payload_hash, status, created_at, updated_at, ${cols.join(', ')})
         VALUES (?1, ?2, ?3, ?4, ?5, 'submitted', ?6, ?6, ${cols.map((_, i) => `?${i + 7}`).join(', ')})`,
      )
      .bind(id, personaId, account.id, input.client_request_id, hash, now, ...cols.map((c) => (normalized as Record<string, unknown>)[c])),
    ctx.db
      .prepare(
        `INSERT INTO notification_outbox (id, event_type, conversation_id, subject_type, subject_id, status, attempts, not_before, created_at)
         VALUES (?1, 'persona_inquiry', ?2, 'persona', ?3, 'pending', 0, ?4, ?4)`,
      )
      .bind(newId('evt'), conversationId, persona.id, now),
  ]);
  scheduleOutboxDrain(ctx);
  const row = await ctx.db.prepare('SELECT * FROM persona_inquiries WHERE id = ?1').bind(id).first<Record<string, unknown>>();
  return { created: true, body: { ...inquiryView(row!), replayed: false, message: INQUIRY_MESSAGE } };
}

export async function listPersonaInquiries(ctx: ServiceContext, account: AgentAccountRow, personaId: string) {
  await loadOwned(ctx, account, personaId);
  const { results } = await ctx.db
    .prepare('SELECT * FROM persona_inquiries WHERE persona_id = ?1 ORDER BY created_at ASC')
    .bind(personaId)
    .all<Record<string, unknown>>();
  return { persona_id: personaId, inquiries: results.map(inquiryView) };
}
