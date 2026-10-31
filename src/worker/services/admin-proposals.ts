import {
  AdminAcceptProposalInput,
  AdminCounterProposalInput,
  AdminCreateProposalInput,
  AdminProposalDecisionInput,
  PROPOSAL_STATUSES,
} from '../schemas/proposals';
import { newId, sha256Hex } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { assertAdminWritable, humanMessageStatements, loadConversation, loadRequest, type AdminContext } from './admin';
import { auditStatement } from './audit';
import { nn, parseInput } from './context';
import { acceptCore, counterCore, createProposalCore, loadProposalBundle, OPEN_STATUSES, proposalView, STATUS_LABELS, transition } from './proposals';
import { nextConversationStatus } from './state';

// Owner side of spec 8.3: the human controls every quote. Each owner action posts an agent-visible message in the
// thread (linked to the request), so an agent that only polls messages still learns about it.

async function bundleOrThrow(ctx: AdminContext, id: string) {
  const bundle = await loadProposalBundle(ctx, id);
  if (!bundle) throw errors.notFound('Proposal not found.');
  return bundle;
}

async function adminView(ctx: AdminContext, id: string) {
  const b = await bundleOrThrow(ctx, id);
  return { ...proposalView(b.proposal, b.revisions, b.events), internal_notes: b.proposal.internal_notes };
}

/**
 * Agent-visible message statements for an owner action. Checked writable up front; the insert itself is also
 * guarded, so a thread closed mid-request gets no message while the proposal record stays readable via the API.
 */
async function threadNotice(ctx: AdminContext, conversationId: string, requestId: string, text: string): Promise<D1PreparedStatement[]> {
  const conv = await loadConversation(ctx, conversationId);
  assertAdminWritable(ctx, conv);
  const status = nextConversationStatus(conv.status, 'human_reply');
  if (!status) throw errors.conflict('This conversation is closed.', 'conversation_closed');
  return humanMessageStatements(ctx, conv, newId('msg'), text, await sha256Hex(text), status, requestId);
}

const howToRead = (requestId: string) =>
  `Read it with GET /v1/requests/${requestId}/proposals (MCP: get_proposal_history). It is nonbinding: nothing is agreed, charged or scheduled.`;

const withMessage = (custom: string | null | undefined, standard: string) => (custom ? `${custom}\n\n${standard}` : standard);

export async function listProposalsAdmin(ctx: AdminContext, status?: string) {
  const s = status && (PROPOSAL_STATUSES as readonly string[]).includes(status) ? status : null;
  const where = s ? 'WHERE p.status = ?1' : `WHERE p.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})`;
  const { results } = await ctx.db
    .prepare(
      `SELECT p.id, p.capability_request_id, p.conversation_id, p.status, p.current_revision, p.agreed_revision, p.initiated_by,
              p.expires_at, p.created_at, p.updated_at, r.actor_type AS last_actor, r.price_minor, r.currency,
              substr(r.scope_text, 1, 200) AS scope_excerpt, c.sender_label
       FROM proposals p
       JOIN proposal_revisions r ON r.proposal_id = p.id AND r.revision = p.current_revision
       JOIN conversations c ON c.id = p.conversation_id
       ${where} ORDER BY p.updated_at DESC LIMIT 200`,
    )
    .bind(...(s ? [s] : []))
    .all<Record<string, unknown> & { status: keyof typeof STATUS_LABELS; last_actor: string }>();
  return {
    items: results.map((r) => ({
      ...r,
      status_label: STATUS_LABELS[r.status],
      awaiting_owner: r.status === 'awaiting_authorization' || ((r.status === 'proposed' || r.status === 'countered') && r.last_actor === 'agent'),
    })),
  };
}

export async function getProposalAdmin(ctx: AdminContext, id: string) {
  const view = await adminView(ctx, id);
  await auditStatement(ctx.db, ctx.actor, 'proposal.view', 'proposal', id, null, ctx.now).run();
  return view;
}

export async function listRequestProposalsAdmin(ctx: AdminContext, requestId: string) {
  await loadRequest(ctx, requestId);
  const { results } = await ctx.db.prepare('SELECT id FROM proposals WHERE capability_request_id = ?1 ORDER BY created_at').bind(requestId).all<{ id: string }>();
  const items = [];
  for (const r of results) items.push(await adminView(ctx, r.id));
  return { items };
}

export async function createProposalAdmin(ctx: AdminContext, requestId: string, raw: unknown) {
  const { message_to_agent, ...terms } = parseInput(AdminCreateProposalInput, raw);
  const request = await loadRequest(ctx, requestId);
  const id = newId('prop');
  const notice = await threadNotice(ctx, request.conversation_id, requestId, withMessage(message_to_agent, `A human posted nonbinding proposal ${id} for request ${requestId}. ${howToRead(requestId)}`));
  await createProposalCore(
    ctx,
    request,
    'admin',
    terms,
    { key: null, hash: null },
    'admin',
    (pid) => [...notice, auditStatement(ctx.db, ctx.actor, 'proposal.create', 'proposal', pid, { request_id: requestId }, ctx.now)],
    id,
  );
  return adminView(ctx, id);
}

export async function counterProposalAdmin(ctx: AdminContext, id: string, raw: unknown) {
  const { message_to_agent, ...terms } = parseInput(AdminCounterProposalInput, raw);
  const bundle = await bundleOrThrow(ctx, id);
  const next = bundle.proposal.current_revision + 1;
  const notice = await threadNotice(
    ctx,
    bundle.proposal.conversation_id,
    bundle.proposal.capability_request_id,
    withMessage(message_to_agent, `A human posted revision ${next} of proposal ${id}. ${howToRead(bundle.proposal.capability_request_id)}`),
  );
  const result = await counterCore(ctx, bundle, 'admin', terms, { key: null, hash: null }, (rev) => [
    ...notice,
    auditStatement(ctx.db, ctx.actor, 'proposal.counter', 'proposal', id, { revision: rev }, ctx.now),
  ]);
  return { ...(await adminView(ctx, id)), agreement_invalidated: result.agreement_invalidated, changed_fields: result.changed_fields };
}

export async function acceptProposalAdmin(ctx: AdminContext, id: string, raw: unknown) {
  const { message_to_agent, ...input } = parseInput(AdminAcceptProposalInput, raw);
  const bundle = await bundleOrThrow(ctx, id);
  const notice = await threadNotice(
    ctx,
    bundle.proposal.conversation_id,
    bundle.proposal.capability_request_id,
    withMessage(
      message_to_agent,
      `A human accepted revision ${input.revision} of proposal ${id} as nonbinding terms. This is not a contract, charge or dispatch. You may request authorization review (POST /v1/proposals/${id}/request-authorization); no work can be authorized in this release.`,
    ),
  );
  await acceptCore(ctx, bundle, 'admin', input, () => [
    ...notice,
    auditStatement(ctx.db, ctx.actor, 'proposal.accept_nonbinding', 'proposal', id, { revision: input.revision }, ctx.now),
  ]);
  return adminView(ctx, id);
}

/**
 * Owner decisions. There is deliberately no "authorize" action: that needs a verified principal, a contract and a
 * payment flow (Phases 5-7), so `authorized` is unreachable here.
 */
export async function decideProposalAdmin(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(AdminProposalDecisionInput, raw);
  const bundle = await bundleOrThrow(ctx, id);
  const p = bundle.proposal;
  const note = nn(input.note) ?? null;
  const requestId = p.capability_request_id;
  let to: 'terms_agreed_nonbinding' | 'cancelled';
  let eventType: string;
  let text: string;
  if (input.action === 'return_to_negotiation') {
    if (p.status !== 'awaiting_authorization') throw errors.conflict('Only a proposal awaiting authorization can be returned to negotiation.', 'invalid_transition');
    to = 'terms_agreed_nonbinding';
    eventType = 'returned_to_negotiation';
    text = `A human returned proposal ${id} to negotiation; it was not authorized.${note ? ` Note: ${note}` : ''} ${howToRead(requestId)}`;
  } else {
    if (!OPEN_STATUSES.includes(p.status)) throw errors.conflict(`This proposal is already ${p.status}.`, 'proposal_closed');
    to = 'cancelled';
    eventType = input.action === 'decline' ? 'declined' : 'withdrawn';
    text = `A human ${input.action === 'decline' ? 'declined' : 'cancelled'} proposal ${id}.${note ? ` Note: ${note}` : ''} Nothing was charged or scheduled.`;
  }
  const notice = await threadNotice(ctx, p.conversation_id, requestId, text);
  await transition(ctx, p, to, eventType, 'admin', note, {}, () => [
    ...notice,
    ...(input.internal_notes !== undefined
      ? [ctx.db.prepare('UPDATE proposals SET internal_notes = ?2 WHERE id = ?1').bind(id, input.internal_notes || null)]
      : []),
    auditStatement(ctx.db, ctx.actor, `proposal.${input.action}`, 'proposal', id, { from_status: p.status, to_status: to }, ctx.now),
  ]);
  return adminView(ctx, id);
}
