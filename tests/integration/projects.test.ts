// Master spec Phase 4: project continuity and preferred-representative relationship requests (section 10).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { json, makeHarness, startConversation, type Harness } from '../helpers';

let ip = 0;
async function account(h: Harness) {
  ip++;
  const body = await json(await h.fetch('/v1/agent-accounts', { method: 'POST', json: { terms_accepted: true }, headers: { 'cf-connecting-ip': `100.64.7.${ip}` } }));
  return { ...body, auth: { authorization: `Bearer ${body.account_token}` } } as { account_id: string; account_token: string; auth: Record<string, string> };
}

async function claimedThread(h: Harness, a: { auth: Record<string, string> }) {
  const c = await startConversation(h);
  const res = await h.fetch('/v1/agent-accounts/me/claim-conversation', { method: 'POST', headers: a.auth, json: { conversation_id: c.conversation_id, conversation_token: c.conversation_token } });
  expect(res.status).toBe(201);
  return c;
}

describe('projects', () => {
  it('groups only claimed conversations and returns a cited history without message text or internal notes', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const c = await claimedThread(h, a);
    const unclaimed = await startConversation(h);

    expect((await json(await h.fetch('/v1/projects', { method: 'POST', headers: a.auth, json: { title: 'Gallery visit', conversation_ids: [unclaimed.conversation_id] } }))).error.details.reason).toBe('conversation_not_linked');
    const created = await h.fetch('/v1/projects', { method: 'POST', headers: a.auth, json: { title: 'Gallery visit', goal: 'Attend an opening', conversation_ids: [c.conversation_id] } });
    expect(created.status).toBe(201);
    const project = await json(created);

    // Activity in the thread: a request, an owner counter on a proposal, an internal note.
    const req = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, { method: 'POST', headers: c.auth, json: { client_request_id: 'r1', objective: 'Attend the opening and describe it.' } }));
    const rid = req.request.request_id;
    const prop = await json(await h.fetch(`/v1/requests/${rid}/proposals`, { method: 'POST', headers: a.auth, json: { client_request_id: 'p1', scope_text: 'Two hours at the opening.' } }));
    await h.admin(`/admin/api/proposals/${prop.proposal_id}/counteroffers`, { method: 'POST', json: { timing_text: 'Friday 7pm' } });
    await h.admin(`/admin/api/capability-requests/${rid}`, { method: 'PATCH', json: { internal_notes: 'SECRET-OWNER-NOTE' } });

    const res = await h.fetch(`/v1/projects/${project.project_id}`, { headers: a.auth });
    expect(res.status).toBe(200);
    const hist = await json(res);
    const raw = JSON.stringify(hist);
    expect(raw).not.toContain('SECRET-OWNER-NOTE');
    expect(raw).not.toContain('Hello, I would like to talk to a human.');
    expect(hist.note).toContain('not memory');
    expect(hist.summary).toMatchObject({ conversations: 1, capability_requests: 1 });
    expect(hist.summary.proposals[0]).toMatchObject({ proposal_id: prop.proposal_id, status: 'countered', current_revision: 2 });
    const types = hist.timeline.map((t: { type: string }) => t.type);
    expect(types).toEqual(expect.arrayContaining(['message', 'capability_request', 'proposal_event']));
    const counter = hist.timeline.find((t: { summary: string }) => t.summary.includes('countered by human'));
    expect(counter.cite).toMatchObject({ proposal_id: prop.proposal_id });
    expect(counter.cite.event_id).toMatch(/^pevt_/);

    // Another account cannot see it; unknown ids look the same.
    const b = await account(h);
    expect((await h.fetch(`/v1/projects/${project.project_id}`, { headers: b.auth })).status).toBe(404);
    expect((await h.fetch(`/v1/projects/proj_${'A'.repeat(22)}`, { headers: b.auth })).status).toBe(404);
    // A thread token is not an account credential.
    expect((await h.fetch(`/v1/projects/${project.project_id}`, { headers: c.auth })).status).toBe(401);

    // Updates: archive and detach.
    const updated = await json(await h.fetch(`/v1/projects/${project.project_id}`, { method: 'PATCH', headers: a.auth, json: { status: 'archived', remove_conversation_ids: [c.conversation_id] } }));
    expect(updated).toMatchObject({ status: 'archived', conversation_ids: [] });
  });
});

describe('relationship requests', () => {
  it('records a preferred-representative request for review; it never becomes active or grants authority', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const res = await h.fetch('/v1/relationships', {
      method: 'POST',
      headers: a.auth,
      json: { client_request_id: 'rel-1', role_type: 'preferred_representative', preferred_rep_ref: 'rep-maria', purpose_text: 'Same person for monthly gallery visits.', requested_term_text: '3 months' },
    });
    expect(res.status).toBe(201);
    const rel = await json(res);
    expect(rel).toMatchObject({ status: 'requested', representative_assigned: false, authority_granted: false, preferred_rep_ref: 'rep-maria' });
    expect(rel.acknowledgement).toContain('consents');
    expect((await h.fetch('/v1/relationships', { method: 'POST', headers: a.auth, json: { client_request_id: 'rel-1', role_type: 'preferred_representative', preferred_rep_ref: 'rep-maria', purpose_text: 'Same person for monthly gallery visits.', requested_term_text: '3 months' } })).status).toBe(200);
    const alert = await env.MHR_DB.prepare("SELECT event_type FROM notification_outbox WHERE subject_type = 'relationship'").first();
    expect(alert).toBeTruthy();

    // Owner review; activation is not available until there are consenting representatives.
    const queue = await json(await h.admin('/admin/api/relationships'));
    expect(queue.items).toHaveLength(1);
    const active = await h.admin(`/admin/api/relationships/${rel.relationship_id}`, { method: 'PATCH', json: { status: 'active' } });
    expect(active.status).toBe(501);
    const reviewed = await json(await h.admin(`/admin/api/relationships/${rel.relationship_id}`, { method: 'PATCH', json: { status: 'under_review', public_status_note: 'Checking availability.', internal_notes: 'PRIVATE' } }));
    expect(reviewed.relationship.status).toBe('under_review');
    const seen = await json(await h.fetch(`/v1/relationships/${rel.relationship_id}`, { headers: a.auth }));
    expect(seen).toMatchObject({ status: 'under_review', public_status_note: 'Checking availability.' });
    expect(JSON.stringify(seen)).not.toContain('PRIVATE');

    // Scoped to the account; withdrawable.
    const b = await account(h);
    expect((await h.fetch(`/v1/relationships/${rel.relationship_id}`, { headers: b.auth })).status).toBe(404);
    expect((await json(await h.fetch(`/v1/relationships/${rel.relationship_id}/withdraw`, { method: 'POST', headers: a.auth }))).status).toBe('withdrawn');
    // Projects and personas must be the requester's own.
    expect((await json(await h.fetch('/v1/relationships', { method: 'POST', headers: b.auth, json: { client_request_id: 'x', role_type: 'spokesperson', purpose_text: 'x', project_id: `proj_${'B'.repeat(22)}` } }))).error.code).toBe('not_found');
  });
});

describe('projects and relationships over MCP', () => {
  it('create_project, get_project_history and request_preferred_representative use the account token', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const c = await claimedThread(h, a);
    const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(new StreamableHTTPClientTransport(new URL('https://myhumanrep.test/mcp'), { fetch: (u, i) => h.fetch(new URL(u.toString()).pathname, i as RequestInit) }));
    type R = { isError?: boolean; structuredContent: Record<string, any> };
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as R;
    const proj = await call('create_project', { account_token: a.account_token, title: 'P', conversation_ids: [c.conversation_id] });
    expect(proj.isError).toBeFalsy();
    const hist = await call('get_project_history', { account_token: a.account_token, project_id: proj.structuredContent.project_id });
    expect(hist.structuredContent.summary.conversations).toBe(1);
    const rel = await call('request_preferred_representative', { account_token: a.account_token, client_request_id: 'r', role_type: 'spokesperson', purpose_text: 'Speak at a panel.', project_id: proj.structuredContent.project_id });
    expect(rel.structuredContent).toMatchObject({ status: 'requested', authority_granted: false });
    expect((await call('get_project_history', { account_token: c.conversation_token, project_id: proj.structuredContent.project_id })).isError).toBe(true);
    await client.close();
  });
});
