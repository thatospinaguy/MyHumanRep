// Master spec Phase 4: versioned nonbinding proposals and counteroffers (T-047, T-048, T-049, T-050).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { counterCore, loadProposalBundle } from '../../src/worker/services/proposals';
import { json, makeHarness, startConversation, type Harness } from '../helpers';

type Thread = Awaited<ReturnType<typeof startConversation>>;

async function request(h: Harness, c: Thread, key = 'r1') {
  const res = await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, {
    method: 'POST',
    headers: c.auth,
    json: { client_request_id: key, objective: 'Photograph the storefront at 12 Main St and describe the signage.' },
  });
  expect(res.status).toBe(201);
  return (await json(res)).request.request_id as string;
}

const TERMS = {
  scope_text: 'One visit, exterior photos only, no entry.',
  deliverables: ['6 photos', 'short written description'],
  timing_text: 'Within 5 days',
  location_text: 'Toronto, ON',
  price: { amount_minor: 18000, currency: 'CAD' },
};

async function propose(h: Harness, c: Thread, requestId: string, extra: Record<string, unknown> = {}) {
  return h.fetch(`/v1/requests/${requestId}/proposals`, { method: 'POST', headers: c.auth, json: { client_request_id: 'p1', ...TERMS, ...extra } });
}

const post = (h: Harness, c: Thread, path: string, body: unknown = {}) => h.fetch(path, { method: 'POST', headers: c.auth, json: body });

describe('nonbinding proposals', () => {
  it('T-047: an agent proposes price and timing; it is nonbinding, nothing is charged, the owner is alerted', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const res = await propose(h, c, rid);
    expect(res.status).toBe(201);
    const p = await json(res);
    expect(p).toMatchObject({
      status: 'proposed',
      status_label: 'nonbinding proposal',
      binding: false,
      charge_created: false,
      work_scheduled: false,
      authorization_available: false,
      current_revision: 1,
      awaiting: 'human',
      initiated_by: 'agent',
    });
    expect(p.current_terms).toMatchObject({ actor: 'agent', price: { amount_minor: 18000, currency: 'CAD' }, location_text: 'Toronto, ON' });
    expect(p.notice).toContain('Nonbinding');
    // Idempotency.
    expect((await propose(h, c, rid)).status).toBe(200);
    expect((await propose(h, c, rid, { timing_text: 'Tomorrow' })).status).toBe(409);
    // Owner alert, without content.
    const alerts = (await env.MHR_DB.prepare("SELECT subject_type FROM notification_outbox WHERE subject_type = 'proposal'").all()).results;
    expect(alerts).toHaveLength(1);
    // Listed for the agent and in the owner queue.
    const list = await json(await h.fetch(`/v1/requests/${rid}/proposals`, { headers: c.auth }));
    expect(list.proposals).toHaveLength(1);
    const queue = await json(await h.admin('/admin/api/proposals'));
    expect(queue.items[0]).toMatchObject({ id: p.proposal_id, awaiting_owner: true });
  });

  it('T-048: counteroffers are new immutable revisions visible to both sides; acceptance needs the other side and the current revision', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const p = await json(await propose(h, c, rid));
    const id = p.proposal_id as string;

    // Nobody accepts their own terms.
    expect((await json(await post(h, c, `/v1/proposals/${id}/accept`, { revision: 1 }))).error.details.reason).toBe('cannot_accept_own_revision');

    // Owner counters with a different price; the agent sees a thread message and the new revision.
    const counter = await h.admin(`/admin/api/proposals/${id}/counteroffers`, { method: 'POST', json: { price: { amount_minor: 24000, currency: 'CAD' } } });
    expect(counter.status).toBe(201);
    const msgs = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth }));
    const notice = msgs.messages.at(-1);
    expect(notice).toMatchObject({ sender: 'human', capability_request_id: rid });
    expect(notice.body).toContain(`revision 2 of proposal ${id}`);
    const seen = await json(await h.fetch(`/v1/proposals/${id}`, { headers: c.auth }));
    expect(seen).toMatchObject({ status: 'countered', current_revision: 2, awaiting: 'agent' });
    expect(seen.revisions[0].price.amount_minor).toBe(18000);
    expect(seen.current_terms).toMatchObject({ actor: 'human', changed_fields: ['price'], material_change: true, scope_text: TERMS.scope_text });

    // Stale acceptance fails; accepting the current revision records nonbinding agreement.
    expect((await json(await post(h, c, `/v1/proposals/${id}/accept`, { revision: 1 }))).error.details.reason).toBe('revision_stale');
    const accepted = await json(await post(h, c, `/v1/proposals/${id}/accept`, { revision: 2 }));
    expect(accepted).toMatchObject({ status: 'terms_agreed_nonbinding', agreed_revision: 2, binding: false, charge_created: false });
    expect((await post(h, c, `/v1/proposals/${id}/accept`, { revision: 2 })).status).toBe(200);

    // A counter with no changes is refused.
    expect((await json(await post(h, c, `/v1/proposals/${id}/counteroffers`, { client_request_id: 'c0', price: { amount_minor: 24000, currency: 'CAD' } }))).error.details.reason).toBe('no_changes');
  });

  it('T-050: changing location after agreement voids the agreement and needs fresh acceptance', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const id = (await json(await propose(h, c, rid))).proposal_id as string;
    await h.admin(`/admin/api/proposals/${id}/accept`, { method: 'POST', json: { revision: 1 } });
    expect((await json(await h.fetch(`/v1/proposals/${id}`, { headers: c.auth }))).status).toBe('terms_agreed_nonbinding');

    const res = await post(h, c, `/v1/proposals/${id}/counteroffers`, { client_request_id: 'move', location_text: 'Ottawa, ON' });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ status: 'countered', agreed_revision: null, current_revision: 2, agreement_invalidated: true, awaiting: 'human' });
    expect(body.current_terms).toMatchObject({ changed_fields: ['location_text'], material_change: true });
    expect(body.events.map((e: { event_type: string }) => e.event_type)).toEqual(['created', 'accepted_nonbinding', 'agreement_invalidated', 'countered']);
    // Authorization cannot be requested on unagreed terms.
    expect((await json(await post(h, c, `/v1/proposals/${id}/request-authorization`))).error.details.reason).toBe('invalid_transition');
    // Replay of the same counter is idempotent.
    expect((await post(h, c, `/v1/proposals/${id}/counteroffers`, { client_request_id: 'move', location_text: 'Ottawa, ON' })).status).toBe(200);
  });

  it('T-049: requesting authorization starts human review only; there is no path to authorized, dispatch or payment', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const id = (await json(await propose(h, c, rid))).proposal_id as string;
    await h.admin(`/admin/api/proposals/${id}/accept`, { method: 'POST', json: { revision: 1 } });

    // Dispatch or payment fields are rejected, not ignored.
    expect((await post(h, c, `/v1/proposals/${id}/request-authorization`, { dispatch: true })).status).toBe(400);
    const auth = await json(await post(h, c, `/v1/proposals/${id}/request-authorization`, { note: 'Ready when you are.' }));
    expect(auth).toMatchObject({ status: 'awaiting_authorization', status_label: 'awaiting authorization', authorization_available: false, work_scheduled: false });
    expect(auth.next_step).toContain('Nothing has been charged, scheduled or dispatched');

    // The owner has no "authorize" action.
    expect((await h.admin(`/admin/api/proposals/${id}/decision`, { method: 'POST', json: { action: 'authorize' } })).status).toBe(400);
    const back = await json(await h.admin(`/admin/api/proposals/${id}/decision`, { method: 'POST', json: { action: 'return_to_negotiation', note: 'No principal yet.' } }));
    expect(back.status).toBe('terms_agreed_nonbinding');
    const statuses = (await env.MHR_DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'authorized'").first<{ n: number }>())!.n;
    expect(statuses).toBe(0);

    // Declining closes it, with a thread message.
    const declined = await json(await h.admin(`/admin/api/proposals/${id}/decision`, { method: 'POST', json: { action: 'decline', note: 'Out of area.' } }));
    expect(declined.status).toBe('cancelled');
    const last = (await json(await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth }))).messages.at(-1);
    expect(last.body).toContain('declined');
    expect((await post(h, c, `/v1/proposals/${id}/counteroffers`, { client_request_id: 'late', timing_text: 'x' })).status).toBe(409);
  });

  it('keeps proposals scoped to the request thread or an account that claimed it', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const other = await startConversation(h);
    const rid = await request(h, c);
    const id = (await json(await propose(h, c, rid))).proposal_id as string;

    const wrong = await h.fetch(`/v1/requests/${rid}/proposals`, { headers: other.auth });
    const unknown = await h.fetch(`/v1/requests/cap_${'A'.repeat(22)}/proposals`, { headers: other.auth });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await json(wrong)).error.code).toBe((await json(unknown)).error.code);
    expect((await h.fetch(`/v1/proposals/${id}`, { headers: other.auth })).status).toBe(401);

    // Accounts: unlinked is refused; after a proof-of-possession claim it works.
    const acct = await json(await h.fetch('/v1/agent-accounts', { method: 'POST', json: { terms_accepted: true }, headers: { 'cf-connecting-ip': '100.64.9.1' } }));
    const aauth = { authorization: `Bearer ${acct.account_token}` };
    expect((await h.fetch(`/v1/proposals/${id}`, { headers: aauth })).status).toBe(401);
    await h.fetch('/v1/agent-accounts/me/claim-conversation', { method: 'POST', headers: aauth, json: { conversation_id: c.conversation_id, conversation_token: c.conversation_token } });
    expect((await h.fetch(`/v1/proposals/${id}`, { headers: aauth })).status).toBe(200);
    expect((await h.fetch(`/v1/proposals/${id}/withdraw`, { method: 'POST', headers: aauth, json: {} })).status).toBe(200);
  });

  it('enforces validity windows, open-proposal limits, request state and the feature flag', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const id = (await json(await propose(h, c, rid, { valid_days: 1 }))).proposal_id as string;
    h.clock.advance(2 * 86_400_000);
    expect((await json(await h.fetch(`/v1/proposals/${id}`, { headers: c.auth }))).status).toBe('expired');
    expect((await json(await post(h, c, `/v1/proposals/${id}/counteroffers`, { client_request_id: 'x', timing_text: 'later' }))).error.details.reason).toBe('proposal_expired');

    for (const key of ['a', 'b', 'c']) expect((await propose(h, c, rid, { client_request_id: key })).status).toBe(201);
    expect((await json(await propose(h, c, rid, { client_request_id: 'd' }))).error.details.reason).toBe('proposal_limit_reached');

    const rid2 = await request(h, c, 'r2');
    await h.admin(`/admin/api/capability-requests/${rid2}`, { method: 'PATCH', json: { status: 'declined' } });
    expect((await json(await propose(h, c, rid2))).error.details.reason).toBe('request_not_open');

    await h.admin('/admin/api/settings', { method: 'PATCH', json: { feature_flags: { nonbinding_proposals_enabled: false } } });
    const off = await h.fetch(`/v1/requests/${rid}/proposals`, { headers: c.auth });
    expect(off.status).toBe(501);
    expect((await json(off)).error.code).toBe('not_yet_available');
  });

  it('lets the owner open a proposal on a request and audits owner actions', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const res = await h.admin(`/admin/api/capability-requests/${rid}/proposals`, {
      method: 'POST',
      json: { scope_text: 'Exterior photos only.', price: { amount_minor: 15000, currency: 'CAD' }, message_to_agent: 'Here is what we could do.' },
    });
    expect(res.status).toBe(201);
    const p = await json(res);
    expect(p).toMatchObject({ initiated_by: 'human', awaiting: 'agent', internal_notes: null });
    const msg = (await json(await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth }))).messages.at(-1);
    expect(msg.body.startsWith('Here is what we could do.')).toBe(true);
    // The agent view never carries internal notes.
    expect('internal_notes' in (await json(await h.fetch(`/v1/proposals/${p.proposal_id}`, { headers: c.auth })))).toBe(false);
    const audit = (await env.MHR_DB.prepare("SELECT action FROM admin_audit WHERE target_type = 'proposal'").all<{ action: string }>()).results.map((r) => r.action);
    expect(audit).toContain('proposal.create');
  });
});

describe('proposal race and expiry regressions', () => {
  it('past-due proposals do not count against the open limit, even if nobody read them', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    for (const key of ['a', 'b', 'c']) expect((await propose(h, c, rid, { client_request_id: key, valid_days: 1 })).status).toBe(201);
    h.clock.advance(2 * 86_400_000);
    // No read in between: creation itself must treat them as expired.
    expect((await propose(h, c, rid, { client_request_id: 'd' })).status).toBe(201);
  });

  it('a counteroffer racing a withdrawal never reopens the closed proposal or writes partial history', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const id = (await json(await propose(h, c, rid))).proposal_id as string;
    const core = { db: env.MHR_DB, now: new Date(h.clock.now().getTime()) };
    const stale = (await loadProposalBundle(core, id))!;
    // The withdrawal commits after the counter read the proposal but before it writes.
    expect((await post(h, c, `/v1/proposals/${id}/withdraw`)).status).toBe(200);
    await expect(counterCore(core, stale, 'admin', { timing_text: 'Next week' }, { key: null, hash: null })).rejects.toMatchObject({ code: 'conflict' });
    const after = await json(await h.fetch(`/v1/proposals/${id}`, { headers: c.auth }));
    expect(after).toMatchObject({ status: 'cancelled', current_revision: 1 });
    expect(after.revisions).toHaveLength(1);
    expect(after.events.map((e: { event_type: string }) => e.event_type)).toEqual(['created', 'withdrawn']);
  });
});

describe('proposals over MCP', () => {
  it('create, history, counter and accept share the REST services; credentials stay scoped', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rid = await request(h, c);
    const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://myhumanrep.test/mcp'), {
        fetch: (u, i) => h.fetch(new URL(u.toString()).pathname, i as RequestInit),
      }),
    );
    type R = { isError?: boolean; structuredContent: Record<string, any> };
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as R;
    const cred = { conversation_token: c.conversation_token };

    const created = await call('create_nonbinding_proposal', { ...cred, request_id: rid, client_request_id: 'm1', ...TERMS });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ status: 'proposed', binding: false, charge_created: false });
    const id = created.structuredContent.proposal_id as string;

    await h.admin(`/admin/api/proposals/${id}/counteroffers`, { method: 'POST', json: { timing_text: 'Within 10 days' } });
    const hist = await call('get_proposal_history', { ...cred, request_id: rid });
    expect(hist.structuredContent.proposals[0]).toMatchObject({ current_revision: 2, awaiting: 'agent' });
    const accepted = await call('accept_nonbinding_proposal', { ...cred, proposal_id: id, revision: 2 });
    expect(accepted.structuredContent.status).toBe('terms_agreed_nonbinding');
    const auth = await call('request_proposal_authorization', { ...cred, proposal_id: id });
    expect(auth.structuredContent).toMatchObject({ status: 'awaiting_authorization', authorization_available: false });

    // Exactly one credential; another thread's token is refused.
    expect((await call('get_proposal_history', { request_id: rid })).isError).toBe(true);
    const other = await startConversation(h);
    const denied = await call('get_proposal_history', { conversation_token: other.conversation_token, request_id: rid });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.http_status).toBe(401);
    await client.close();
  });
});

