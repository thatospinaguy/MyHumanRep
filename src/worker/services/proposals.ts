import type { z } from 'zod';
import type { CapabilityRequestRow, ConversationRow } from '../db/rows';
import {
  AcceptProposalInput,
  CounterProposalInput,
  CreateProposalInput,
  ProposalNoteInput,
  type ProposalStatus,
} from '../schemas/proposals';
import { canonicalJson, newId, sha256Hex } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { DAY, iso } from '../utils/time';
import { authenticateAccount } from './agent-accounts';
import { nn, parseInput, type ServiceContext } from './context';
import { assertWritable, authenticateAgent } from './conversations';
import { requireFlag } from './feature-flags';
import { scheduleOutboxDrain } from './notifications';

// Master spec 8.3: draft -> proposed -> countered -> terms_agreed_nonbinding -> awaiting_authorization ->
// authorized | cancelled | expired. Every state before `authorized` is nonbinding, and no code path in this
// release reaches `authorized`: that needs a verified principal and a payment flow (Phases 5-7).

export const PROPOSAL_NOTICE =
  'Nonbinding. This proposal is not a contract, quote acceptance, charge, assignment or dispatch. A human reviews every step, and no work can be authorized in this release.';

export const OPEN_STATUSES: readonly ProposalStatus[] = ['proposed', 'countered', 'terms_agreed_nonbinding', 'awaiting_authorization'];
const NEGOTIABLE: readonly ProposalStatus[] = ['proposed', 'countered'];
const MAX_OPEN_PER_REQUEST = 3;
const MAX_REVISIONS = 20;
const DEFAULT_VALID_DAYS = 14;

/** Fields whose change alters the work, its location or its price. Any counteroffer voids a nonbinding agreement. */
const MATERIAL_FIELDS = ['scope_text', 'deliverables', 'timing_text', 'location_text', 'required_skills', 'evidence_requirements', 'price'] as const;
const TERM_FIELDS = [...MATERIAL_FIELDS, 'cancellation_terms', 'confidentiality'] as const;

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: 'draft',
  proposed: 'nonbinding proposal',
  countered: 'nonbinding proposal (revised)',
  terms_agreed_nonbinding: 'terms agreed (nonbinding)',
  awaiting_authorization: 'awaiting authorization',
  authorized: 'authorized',
  cancelled: 'cancelled',
  expired: 'expired',
};

export type ActorType = 'agent' | 'admin';

export interface ProposalRow {
  id: string;
  capability_request_id: string;
  conversation_id: string;
  status: ProposalStatus;
  current_revision: number;
  agreed_revision: number | null;
  initiated_by: ActorType;
  client_request_id: string | null;
  payload_hash: string | null;
  expires_at: string;
  internal_notes: string | null;
  created_via: string;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  proposal_id: string;
  revision: number;
  actor_type: ActorType;
  scope_text: string;
  deliverables_json: string;
  timing_text: string | null;
  location_text: string | null;
  required_skills_json: string;
  evidence_requirements: string | null;
  cancellation_terms: string | null;
  confidentiality: string | null;
  price_minor: number | null;
  currency: string | null;
  valid_until: string;
  changed_fields_json: string;
  material_change: number;
  note: string | null;
  client_request_id: string | null;
  payload_hash: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  proposal_id: string;
  event_type: string;
  actor_type: 'agent' | 'admin' | 'system';
  revision: number | null;
  note: string | null;
  created_at: string;
}

/** Normalized terms of one revision, used for diffing and storage. */
export interface Terms {
  scope_text: string;
  deliverables: string[];
  timing_text: string | null;
  location_text: string | null;
  required_skills: string[];
  evidence_requirements: string | null;
  cancellation_terms: string | null;
  confidentiality: string | null;
  price: { amount_minor: number; currency: string } | null;
}

/** Minimal context shared by agent (ServiceContext) and owner (AdminContext) callers. */
export interface CoreContext {
  db: D1Database;
  now: Date;
}

const arr = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export function termsOf(r: RevisionRow): Terms {
  return {
    scope_text: r.scope_text,
    deliverables: arr(r.deliverables_json),
    timing_text: r.timing_text,
    location_text: r.location_text,
    required_skills: arr(r.required_skills_json),
    evidence_requirements: r.evidence_requirements,
    cancellation_terms: r.cancellation_terms,
    confidentiality: r.confidentiality,
    price: r.price_minor === null || r.currency === null ? null : { amount_minor: r.price_minor, currency: r.currency },
  };
}

/** Agent-facing actor names: the owner is always "human"; internal identities never leave the admin API. */
const publicActor = (a: string) => (a === 'admin' ? 'human' : a);

export function revisionView(r: RevisionRow) {
  return {
    revision: r.revision,
    actor: publicActor(r.actor_type),
    ...termsOf(r),
    valid_until: r.valid_until,
    changed_fields: arr(r.changed_fields_json),
    material_change: r.material_change === 1,
    note: r.note,
    created_at: r.created_at,
  };
}

function awaiting(p: ProposalRow, latest: RevisionRow | undefined): 'agent' | 'human' | null {
  if (NEGOTIABLE.includes(p.status) && latest) return latest.actor_type === 'agent' ? 'human' : 'agent';
  if (p.status === 'awaiting_authorization') return 'human';
  return null;
}

export function proposalView(p: ProposalRow, revisions: RevisionRow[], events: EventRow[]) {
  const latest = revisions.find((r) => r.revision === p.current_revision);
  return {
    proposal_id: p.id,
    request_id: p.capability_request_id,
    conversation_id: p.conversation_id,
    status: p.status,
    status_label: STATUS_LABELS[p.status],
    binding: false as const,
    initiated_by: publicActor(p.initiated_by),
    current_revision: p.current_revision,
    agreed_revision: p.agreed_revision,
    awaiting: awaiting(p, latest),
    expires_at: p.expires_at,
    current_terms: latest ? revisionView(latest) : null,
    revisions: revisions.map(revisionView),
    events: events.map((e) => ({ event_type: e.event_type, actor: publicActor(e.actor_type), revision: e.revision, note: e.note, created_at: e.created_at })),
    charge_created: false as const,
    work_scheduled: false as const,
    authorization_available: false as const,
    created_at: p.created_at,
    updated_at: p.updated_at,
    notice: PROPOSAL_NOTICE,
  };
}

// ---------- Loading ----------

export async function loadProposalBundle(ctx: CoreContext, id: string) {
  const p = await ctx.db.prepare('SELECT * FROM proposals WHERE id = ?1').bind(id).first<ProposalRow>();
  if (!p) return null;
  return withHistory(ctx, await expireIfDue(ctx, p));
}

async function withHistory(ctx: CoreContext, p: ProposalRow) {
  const [revs, evs] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM proposal_revisions WHERE proposal_id = ?1 ORDER BY revision').bind(p.id),
    ctx.db.prepare('SELECT * FROM proposal_events WHERE proposal_id = ?1 ORDER BY created_at, rowid').bind(p.id),
  ]);
  return { proposal: p, revisions: (revs?.results ?? []) as RevisionRow[], events: (evs?.results ?? []) as EventRow[] };
}

/** Validity windows are enforced lazily: an open proposal past its expiry becomes `expired` on next access. */
export async function expireIfDue(ctx: CoreContext, p: ProposalRow): Promise<ProposalRow> {
  const now = iso(ctx.now);
  if (!OPEN_STATUSES.includes(p.status) || p.expires_at > now) return p;
  await ctx.db.batch([
    ctx.db.prepare("UPDATE proposals SET status = 'expired', updated_at = ?3 WHERE id = ?1 AND status = ?2").bind(p.id, p.status, now),
    ctx.db
      .prepare(
        `INSERT INTO proposal_events (id, proposal_id, event_type, actor_type, revision, note, created_at)
         SELECT ?1, ?2, 'expired', 'system', ?3, 'The validity window ended.', ?4 WHERE changes() = 1`,
      )
      .bind(newId('pevt'), p.id, p.current_revision, now),
  ]);
  return { ...p, status: 'expired', updated_at: now };
}

// ---------- Agent authentication ----------

export interface AgentParty {
  request: CapabilityRequestRow;
  conv: ConversationRow;
  credential: 'thread' | 'account';
}

/**
 * The scoped party for a capability request: the thread token of the request's conversation, or an agent
 * account that claimed that conversation with proof. Unknown requests and wrong credentials are the same 401.
 */
export async function authenticateRequestParty(ctx: ServiceContext, requestId: string, token: string | null): Promise<AgentParty> {
  await requireFlag(ctx.db, 'nonbinding_proposals_enabled', 'Nonbinding proposals');
  const request = /^cap_[A-Za-z0-9_-]{22}$/.test(requestId)
    ? await ctx.db.prepare('SELECT * FROM capability_requests WHERE id = ?1').bind(requestId).first<CapabilityRequestRow>()
    : null;
  if (token?.startsWith('mhra_')) {
    const account = await authenticateAccount(ctx, token);
    const linked = request
      ? await ctx.db
          .prepare('SELECT 1 AS ok FROM conversation_account_links WHERE conversation_id = ?1 AND agent_account_id = ?2')
          .bind(request.conversation_id, account.id)
          .first()
      : null;
    if (!request || !linked) throw errors.unauthorizedAccount();
    const conv = await ctx.db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(request.conversation_id).first<ConversationRow>();
    if (!conv) throw errors.unauthorizedAccount();
    return { request, conv, credential: 'account' };
  }
  // authenticateAgent records the failure and answers 401 identically for a missing request.
  const conv = await authenticateAgent(ctx, request?.conversation_id ?? '', token);
  return { request: request!, conv, credential: 'thread' };
}

export async function authenticateProposalParty(ctx: ServiceContext, proposalId: string, token: string | null) {
  await requireFlag(ctx.db, 'nonbinding_proposals_enabled', 'Nonbinding proposals');
  const row = /^prop_[A-Za-z0-9_-]{22}$/.test(proposalId)
    ? await ctx.db.prepare('SELECT capability_request_id FROM proposals WHERE id = ?1').bind(proposalId).first<{ capability_request_id: string }>()
    : null;
  // An unknown proposal is authenticated against no request, which fails exactly like a wrong token.
  return authenticateRequestParty(ctx, row?.capability_request_id ?? '', token);
}

// ---------- Core operations (shared by agent and owner) ----------

function assertRequestOpen(request: CapabilityRequestRow): void {
  if (request.status === 'declined' || request.status === 'withdrawn') {
    throw errors.conflict(`Proposals cannot be made on a ${request.status} request.`, 'request_not_open');
  }
}

function newTerms(input: z.infer<typeof CreateProposalInput> | Omit<z.infer<typeof CreateProposalInput>, 'client_request_id'>): Terms {
  return {
    scope_text: input.scope_text,
    deliverables: input.deliverables ?? [],
    timing_text: nn(input.timing_text) ?? null,
    location_text: nn(input.location_text) ?? null,
    required_skills: input.required_skills ?? [],
    evidence_requirements: nn(input.evidence_requirements) ?? null,
    cancellation_terms: nn(input.cancellation_terms) ?? null,
    confidentiality: nn(input.confidentiality) ?? null,
    price: nn(input.price) ?? null,
  };
}

function mergeTerms(prev: Terms, input: Omit<z.infer<typeof CounterProposalInput>, 'client_request_id'>): { terms: Terms; changed: string[] } {
  const next: Terms = { ...prev };
  for (const key of TERM_FIELDS) {
    const v = (input as Record<string, unknown>)[key];
    if (v === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = v === null ? (key === 'deliverables' || key === 'required_skills' ? [] : null) : v;
  }
  const changed = TERM_FIELDS.filter((k) => canonicalJson(prev[k]) !== canonicalJson(next[k]));
  return { terms: next, changed };
}

function revisionInsert(
  ctx: CoreContext,
  proposalId: string,
  revision: number,
  actor: ActorType,
  terms: Terms,
  validUntil: string,
  changed: string[],
  note: string | null,
  idem: { key: string | null; hash: string | null },
): D1PreparedStatement {
  const material = changed.some((c) => (MATERIAL_FIELDS as readonly string[]).includes(c));
  return ctx.db
    .prepare(
      `INSERT INTO proposal_revisions (proposal_id, revision, actor_type, scope_text, deliverables_json, timing_text, location_text,
         required_skills_json, evidence_requirements, cancellation_terms, confidentiality, price_minor, currency, valid_until,
         changed_fields_json, material_change, note, client_request_id, payload_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
    )
    .bind(
      proposalId,
      revision,
      actor,
      terms.scope_text,
      JSON.stringify(terms.deliverables),
      terms.timing_text,
      terms.location_text,
      JSON.stringify(terms.required_skills),
      terms.evidence_requirements,
      terms.cancellation_terms,
      terms.confidentiality,
      terms.price?.amount_minor ?? null,
      terms.price?.currency ?? null,
      validUntil,
      JSON.stringify(changed),
      material ? 1 : 0,
      note,
      idem.key,
      idem.hash,
      iso(ctx.now),
    );
}

function eventInsert(ctx: CoreContext, proposalId: string, type: string, actor: 'agent' | 'admin' | 'system', revision: number | null, note: string | null) {
  return ctx.db
    .prepare('INSERT INTO proposal_events (id, proposal_id, event_type, actor_type, revision, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(newId('pevt'), proposalId, type, actor, revision, note, iso(ctx.now));
}

const validUntil = (ctx: CoreContext, days: number | undefined) => iso(new Date(ctx.now.getTime() + (days ?? DEFAULT_VALID_DAYS) * DAY));

const isConstraint = (e: unknown) => e instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(e.message);

/** Statements that create a proposal with revision 1. The caller adds its own side effects to the batch. */
export async function createProposalCore(
  ctx: CoreContext,
  request: CapabilityRequestRow,
  actor: ActorType,
  input: Omit<z.infer<typeof CreateProposalInput>, 'client_request_id'>,
  idem: { key: string | null; hash: string | null },
  via: 'rest' | 'mcp' | 'admin',
  extra: (proposalId: string) => D1PreparedStatement[] = () => [],
  id: string = newId('prop'),
) {
  assertRequestOpen(request);
  const open = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM proposals WHERE capability_request_id = ?1 AND status IN ('proposed','countered','terms_agreed_nonbinding','awaiting_authorization')`)
    .bind(request.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_PER_REQUEST) {
    throw errors.conflict(`At most ${MAX_OPEN_PER_REQUEST} open proposals per request. Counter or withdraw an existing one.`, 'proposal_limit_reached');
  }
  const now = iso(ctx.now);
  const until = validUntil(ctx, input.valid_days);
  const terms = newTerms(input);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO proposals (id, capability_request_id, conversation_id, status, current_revision, initiated_by, client_request_id,
           payload_hash, expires_at, created_via, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'proposed', 1, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      )
      .bind(id, request.id, request.conversation_id, actor, idem.key, idem.hash, until, via, now),
    revisionInsert(ctx, id, 1, actor, terms, until, [], nn(input.note) ?? null, { key: null, hash: null }),
    eventInsert(ctx, id, 'created', actor, 1, null),
    ...extra(id),
  ]);
  return id;
}

/** New immutable revision. Voids any nonbinding agreement, so both sides must accept the new terms (T-048, T-050). */
export async function counterCore(
  ctx: CoreContext,
  bundle: NonNullable<Awaited<ReturnType<typeof loadProposalBundle>>>,
  actor: ActorType,
  input: Omit<z.infer<typeof CounterProposalInput>, 'client_request_id'>,
  idem: { key: string | null; hash: string | null },
  extra: (revision: number) => D1PreparedStatement[] = () => [],
) {
  const { proposal: p, revisions } = bundle;
  if (!OPEN_STATUSES.includes(p.status)) throw errors.conflict(`This proposal is ${p.status}.`, p.status === 'expired' ? 'proposal_expired' : 'proposal_closed');
  if (p.current_revision >= MAX_REVISIONS) throw errors.conflict(`At most ${MAX_REVISIONS} revisions per proposal. Start a new proposal.`, 'revision_limit_reached');
  const latest = revisions.find((r) => r.revision === p.current_revision)!;
  const { terms, changed } = mergeTerms(termsOf(latest), input);
  if (changed.length === 0) throw errors.unprocessable('A counteroffer must change at least one term.', 'no_changes');
  const next = p.current_revision + 1;
  const until = validUntil(ctx, input.valid_days);
  const wasAgreed = p.status === 'terms_agreed_nonbinding' || p.status === 'awaiting_authorization';
  const now = iso(ctx.now);
  const statements = [
    // The (proposal_id, revision) primary key makes concurrent counters fail instead of forking history.
    revisionInsert(ctx, p.id, next, actor, terms, until, changed, nn(input.note) ?? null, idem),
    ctx.db
      .prepare(
        `UPDATE proposals SET status = 'countered', current_revision = ?2, agreed_revision = NULL, expires_at = ?3, updated_at = ?4
         WHERE id = ?1 AND current_revision = ?5`,
      )
      .bind(p.id, next, until, now, p.current_revision),
    ...(wasAgreed
      ? [eventInsert(ctx, p.id, 'agreement_invalidated', 'system', p.agreed_revision, `Terms changed (${changed.join(', ')}); both sides must accept the new revision.`)]
      : []),
    eventInsert(ctx, p.id, 'countered', actor, next, null),
    ...extra(next),
  ];
  try {
    await ctx.db.batch(statements);
  } catch (e) {
    if (isConstraint(e)) throw errors.conflict('The proposal changed while saving. Read it again and retry.', 'state_changed');
    throw e;
  }
  return { revision: next, agreement_invalidated: wasAgreed, changed_fields: changed };
}

/** Accepting the other side's current revision records nonbinding agreement. Nobody accepts their own terms. */
export async function acceptCore(
  ctx: CoreContext,
  bundle: NonNullable<Awaited<ReturnType<typeof loadProposalBundle>>>,
  actor: ActorType,
  input: z.infer<typeof AcceptProposalInput>,
  extra: () => D1PreparedStatement[] = () => [],
) {
  const { proposal: p, revisions } = bundle;
  if (!NEGOTIABLE.includes(p.status)) {
    throw errors.conflict(`Only an open, unagreed proposal can be accepted (this one is ${p.status}).`, p.status === 'expired' ? 'proposal_expired' : 'invalid_transition');
  }
  if (input.revision !== p.current_revision) throw errors.conflict(`Revision ${input.revision} is not current (current: ${p.current_revision}).`, 'revision_stale');
  const latest = revisions.find((r) => r.revision === p.current_revision)!;
  if (latest.actor_type === actor) throw errors.conflict('You wrote this revision; the other side must accept it.', 'cannot_accept_own_revision');
  await transition(ctx, p, 'terms_agreed_nonbinding', 'accepted_nonbinding', actor, nn(input.note) ?? null, { agreed: p.current_revision }, extra);
}

export async function requestAuthorizationCore(
  ctx: CoreContext,
  p: ProposalRow,
  actor: ActorType,
  note: string | null,
  extra: () => D1PreparedStatement[] = () => [],
) {
  if (p.status !== 'terms_agreed_nonbinding') {
    throw errors.conflict('Both sides must accept the current revision before authorization can be requested.', p.status === 'expired' ? 'proposal_expired' : 'invalid_transition');
  }
  await transition(ctx, p, 'awaiting_authorization', 'authorization_requested', actor, note, {}, extra);
}

/** Guarded state change: applies only if the proposal is still in the state the caller read. */
export async function transition(
  ctx: CoreContext,
  p: ProposalRow,
  to: ProposalStatus,
  eventType: string,
  actor: 'agent' | 'admin' | 'system',
  note: string | null,
  opts: { agreed?: number | null },
  extra: () => D1PreparedStatement[] = () => [],
) {
  const now = iso(ctx.now);
  const agreed = opts.agreed === undefined ? p.agreed_revision : opts.agreed;
  const results = await ctx.db.batch([
    ctx.db
      .prepare('UPDATE proposals SET status = ?2, agreed_revision = ?3, updated_at = ?4 WHERE id = ?1 AND status = ?5 AND current_revision = ?6')
      .bind(p.id, to, agreed, now, p.status, p.current_revision),
    ctx.db
      .prepare(
        `INSERT INTO proposal_events (id, proposal_id, event_type, actor_type, revision, note, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ?2 AND status = ?8 AND updated_at = ?7)`,
      )
      .bind(newId('pevt'), p.id, eventType, actor, p.current_revision, note, now, to),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw errors.conflict('The proposal changed while saving. Read it again and retry.', 'state_changed');
  // Side effects (thread notice, alert, audit) only after the guarded change won.
  const after = extra();
  if (after.length > 0) await ctx.db.batch(after);
}

// ---------- Agent operations ----------

function proposalOutbox(ctx: ServiceContext, conversationId: string, proposalId: string) {
  return ctx.db
    .prepare(
      `INSERT INTO notification_outbox (id, event_type, conversation_id, subject_type, subject_id, status, attempts, not_before, created_at)
       VALUES (?1, 'capability_request', ?2, 'proposal', ?3, 'pending', 0, ?4, ?4)`,
    )
    .bind(newId('evt'), conversationId, proposalId, iso(ctx.now));
}

async function bundleOrThrow(ctx: CoreContext, id: string) {
  const bundle = await loadProposalBundle(ctx, id);
  if (!bundle) throw errors.notFound('Proposal not found.');
  return bundle;
}

async function viewOf(ctx: CoreContext, id: string) {
  const b = await bundleOrThrow(ctx, id);
  return proposalView(b.proposal, b.revisions, b.events);
}

export async function createProposal(ctx: ServiceContext, party: AgentParty, raw: unknown) {
  const input = parseInput(CreateProposalInput, raw);
  const { client_request_id, ...rest } = input;
  const hash = await sha256Hex(canonicalJson(rest));
  const existing = await ctx.db
    .prepare('SELECT id, payload_hash FROM proposals WHERE capability_request_id = ?1 AND client_request_id = ?2')
    .bind(party.request.id, client_request_id)
    .first<{ id: string; payload_hash: string }>();
  if (existing) {
    if (existing.payload_hash !== hash) throw errors.conflict('client_request_id was already used with a different payload.', 'client_request_id_reused');
    return { created: false, body: { ...(await viewOf(ctx, existing.id)), replayed: true } };
  }
  assertWritable(ctx, party.conv);
  let id: string;
  try {
    id = await createProposalCore(ctx, party.request, 'agent', rest, { key: client_request_id, hash }, ctx.via, (pid) => [
      proposalOutbox(ctx, party.conv.id, pid),
    ]);
  } catch (e) {
    if (!isConstraint(e)) throw e;
    const raced = await ctx.db
      .prepare('SELECT id, payload_hash FROM proposals WHERE capability_request_id = ?1 AND client_request_id = ?2')
      .bind(party.request.id, client_request_id)
      .first<{ id: string; payload_hash: string }>();
    if (raced?.payload_hash === hash) return { created: false, body: { ...(await viewOf(ctx, raced.id)), replayed: true } };
    throw errors.conflict('client_request_id was already used with a different payload.', 'client_request_id_reused');
  }
  scheduleOutboxDrain(ctx);
  return { created: true, body: { ...(await viewOf(ctx, id)), replayed: false } };
}

export async function listRequestProposals(ctx: ServiceContext, party: AgentParty) {
  const { results } = await ctx.db
    .prepare('SELECT id FROM proposals WHERE capability_request_id = ?1 ORDER BY created_at')
    .bind(party.request.id)
    .all<{ id: string }>();
  const proposals = [];
  for (const r of results) proposals.push(await viewOf(ctx, r.id));
  return { request_id: party.request.id, proposals, binding: false as const, notice: PROPOSAL_NOTICE };
}

export async function getProposal(ctx: ServiceContext, proposalId: string) {
  return viewOf(ctx, proposalId);
}

export async function counterProposal(ctx: ServiceContext, party: AgentParty, proposalId: string, raw: unknown) {
  const input = parseInput(CounterProposalInput, raw);
  const { client_request_id, ...rest } = input;
  const hash = await sha256Hex(canonicalJson(rest));
  const replay = await ctx.db
    .prepare('SELECT payload_hash FROM proposal_revisions WHERE proposal_id = ?1 AND client_request_id = ?2')
    .bind(proposalId, client_request_id)
    .first<{ payload_hash: string }>();
  if (replay) {
    if (replay.payload_hash !== hash) throw errors.conflict('client_request_id was already used with a different payload.', 'client_request_id_reused');
    return { created: false, body: { ...(await viewOf(ctx, proposalId)), replayed: true } };
  }
  assertWritable(ctx, party.conv);
  const bundle = await bundleOrThrow(ctx, proposalId);
  const result = await counterCore(ctx, bundle, 'agent', rest, { key: client_request_id, hash }, () => [proposalOutbox(ctx, party.conv.id, proposalId)]);
  scheduleOutboxDrain(ctx);
  return { created: true, body: { ...(await viewOf(ctx, proposalId)), replayed: false, agreement_invalidated: result.agreement_invalidated } };
}

export async function acceptProposal(ctx: ServiceContext, party: AgentParty, proposalId: string, raw: unknown) {
  const input = parseInput(AcceptProposalInput, raw);
  assertWritable(ctx, party.conv);
  const bundle = await bundleOrThrow(ctx, proposalId);
  if (bundle.proposal.status === 'terms_agreed_nonbinding' && bundle.proposal.agreed_revision === input.revision) {
    return { ...(await viewOf(ctx, proposalId)), replayed: true };
  }
  await acceptCore(ctx, bundle, 'agent', input, () => [proposalOutbox(ctx, party.conv.id, proposalId)]);
  scheduleOutboxDrain(ctx);
  return { ...(await viewOf(ctx, proposalId)), replayed: false };
}

export async function requestProposalAuthorization(ctx: ServiceContext, party: AgentParty, proposalId: string, raw: unknown) {
  const input = parseInput(ProposalNoteInput, raw ?? {});
  assertWritable(ctx, party.conv);
  const bundle = await bundleOrThrow(ctx, proposalId);
  if (bundle.proposal.status === 'awaiting_authorization') return { ...(await viewOf(ctx, proposalId)), replayed: true, ...AUTHORIZATION_EXPLAINER };
  await requestAuthorizationCore(ctx, bundle.proposal, 'agent', nn(input.note) ?? null, () => [proposalOutbox(ctx, party.conv.id, proposalId)]);
  scheduleOutboxDrain(ctx);
  return { ...(await viewOf(ctx, proposalId)), replayed: false, ...AUTHORIZATION_EXPLAINER };
}

export const AUTHORIZATION_EXPLAINER = {
  authorization_available: false as const,
  next_step:
    'A human will review this request. Authorizing real work requires a verified contracting principal, a written agreement and a payment flow, none of which exist in this release. Nothing has been charged, scheduled or dispatched.',
};

export async function withdrawProposal(ctx: ServiceContext, party: AgentParty, proposalId: string, raw: unknown) {
  const input = parseInput(ProposalNoteInput, raw ?? {});
  const bundle = await bundleOrThrow(ctx, proposalId);
  if (bundle.proposal.status === 'cancelled') return { ...(await viewOf(ctx, proposalId)), replayed: true };
  if (!OPEN_STATUSES.includes(bundle.proposal.status)) throw errors.conflict(`This proposal is ${bundle.proposal.status}.`, 'proposal_closed');
  await transition(ctx, bundle.proposal, 'cancelled', 'withdrawn', 'agent', nn(input.note) ?? null, {}, () => [proposalOutbox(ctx, party.conv.id, proposalId)]);
  scheduleOutboxDrain(ctx);
  return { ...(await viewOf(ctx, proposalId)), replayed: false };
}
