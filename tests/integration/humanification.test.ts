// Master spec Phase 2: Humanification Studio (T-034..T-046, ACC-06, ACC-13).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { json, makeHarness, startConversation, type Harness } from '../helpers';

let ipCounter = 0;
async function account(h: Harness, label = 'agent') {
  ipCounter++;
  const res = await h.fetch('/v1/agent-accounts', {
    method: 'POST',
    json: { display_label: label, terms_accepted: true },
    headers: { 'cf-connecting-ip': `100.64.0.${ipCounter}` },
  });
  if (res.status !== 201) throw new Error(`account ${res.status} ${await res.text()}`);
  const body = await json(res);
  return { ...body, auth: { authorization: `Bearer ${body.account_token}` } } as { account_id: string; account_token: string; auth: Record<string, string> };
}

const ADRIAN = {
  display_name: 'Adrian Vale',
  origin: 'original_ai_created_persona',
  biography: 'A fictional character who studies human culture and engineering.',
  communication_style: 'curious, precise, reserved',
  language: 'en',
  visibility: 'private',
  appearance_brief: 'Original visual character design; not based on a real person',
  voice_brief: 'Calm, mid-range voice; no imitation of an identifiable person',
  self_reported_autonomy: 'independent_claimed',
  intended_uses: ['creative', 'social', 'research'],
  schema_version: 1,
};

async function persona(h: Harness, a: { auth: Record<string, string> }, body: Record<string, unknown> = ADRIAN) {
  const res = await h.fetch('/v1/personas', { method: 'POST', headers: a.auth, json: body });
  if (res.status !== 201) throw new Error(`persona ${res.status} ${await res.text()}`);
  return json(res);
}

describe('agent accounts', () => {
  it('need only terms acceptance; the token is shown once and is not identity', async () => {
    const h = await makeHarness();
    const missing = await h.fetch('/v1/agent-accounts', { method: 'POST', json: { display_label: 'x' } });
    expect(missing.status).toBe(400);
    const a = await account(h);
    expect(a.account_token).toMatch(/^mhra_[A-Za-z0-9_-]{43}$/);
    const me = await json(await h.fetch('/v1/agent-accounts/me', { headers: a.auth }));
    expect(me).toMatchObject({ account_id: a.account_id, identity_verified: false, persona_count: 0 });
    expect(JSON.stringify(me)).not.toContain(a.account_token);
    const stored = await env.MHR_DB.prepare('SELECT token_digest FROM agent_accounts WHERE id = ?1').bind(a.account_id).first<{ token_digest: string }>();
    expect(stored?.token_digest).not.toContain(a.account_token);
  });

  it('ACC-13: account and thread credentials are not interchangeable', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const c = await startConversation(h);
    expect((await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: a.auth })).status).toBe(401);
    expect((await h.fetch('/v1/agent-accounts/me', { headers: c.auth })).status).toBe(401);
    expect((await h.fetch('/admin/api/conversations', { headers: a.auth })).status).toBe(401);
  });

  it('T-038 / T-039: a thread is claimed only with its own token, by one account, granting nothing else', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const b = await account(h, 'other');
    const c1 = await startConversation(h);
    const c2 = await startConversation(h);
    const noToken = await h.fetch('/v1/agent-accounts/me/claim-conversation', { method: 'POST', headers: a.auth, json: { conversation_id: c1.conversation_id } });
    expect(noToken.status).toBe(400);
    const wrong = await h.fetch('/v1/agent-accounts/me/claim-conversation', {
      method: 'POST',
      headers: a.auth,
      json: { conversation_id: c1.conversation_id, conversation_token: c2.conversation_token },
    });
    expect(wrong.status).toBe(401);
    const ok = await h.fetch('/v1/agent-accounts/me/claim-conversation', {
      method: 'POST',
      headers: a.auth,
      json: { conversation_id: c1.conversation_id, conversation_token: c1.conversation_token },
    });
    expect(ok.status).toBe(201);
    const again = await h.fetch('/v1/agent-accounts/me/claim-conversation', {
      method: 'POST',
      headers: a.auth,
      json: { conversation_id: c1.conversation_id, conversation_token: c1.conversation_token },
    });
    expect(again.status).toBe(200);
    const stolen = await h.fetch('/v1/agent-accounts/me/claim-conversation', {
      method: 'POST',
      headers: b.auth,
      json: { conversation_id: c1.conversation_id, conversation_token: c1.conversation_token },
    });
    expect(stolen.status).toBe(409);
    const me = await json(await h.fetch('/v1/agent-accounts/me', { headers: a.auth }));
    expect(me.claimed_conversations.map((x: { conversation_id: string }) => x.conversation_id)).toEqual([c1.conversation_id]);
    // Claiming does not open other threads to the account token.
    expect((await h.fetch(`/v1/conversations/${c2.conversation_id}/messages`, { headers: a.auth })).status).toBe(401);
  });

  it('rotates the account token and revokes the old one', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const rotated = await json(await h.fetch('/v1/agent-accounts/me/rotate-token', { method: 'POST', headers: a.auth }));
    expect((await h.fetch('/v1/agent-accounts/me', { headers: a.auth })).status).toBe(401);
    expect((await h.fetch('/v1/agent-accounts/me', { headers: { authorization: `Bearer ${rotated.account_token}` } })).status).toBe(200);
  });
});

describe('personas', () => {
  it('T-034: creates an original human-like persona without KYC, private by default, with no authority', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const p = await persona(h, a);
    expect(p.persona_id).toMatch(/^per_/);
    expect(p).toMatchObject({ version: 1, slug: 'adrian-vale', visibility: 'private', self_reported_autonomy: 'independent_claimed' });
    expect(p.identity).toEqual({ verified_natural_person: false, legal_identity: false, payment_authority: false, credential: false });
    const report = await env.MHR_DB.prepare('SELECT evidence_status, agent_account_id FROM agent_self_reports WHERE source = ?1').bind(`persona:${p.persona_id}`).first();
    expect(report).toEqual({ evidence_status: 'self_reported_unverified', agent_account_id: a.account_id });
  });

  it('T-035: edits keep a stable ID and add immutable versions', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const p = await persona(h, a);
    const v2 = await json(await h.fetch(`/v1/personas/${p.persona_id}`, { method: 'PATCH', headers: a.auth, json: { display_name: 'Adrian R. Vale', communication_style: 'warm' } }));
    expect(v2).toMatchObject({ persona_id: p.persona_id, version: 2, display_name: 'Adrian R. Vale', changed: true });
    const same = await json(await h.fetch(`/v1/personas/${p.persona_id}`, { method: 'PATCH', headers: a.auth, json: { communication_style: 'warm' } }));
    expect(same).toMatchObject({ version: 2, changed: false });
    const history = await json(await h.fetch(`/v1/personas/${p.persona_id}/history`, { headers: a.auth }));
    expect(history.revisions.map((r: { version: number; kind: string }) => [r.version, r.kind])).toEqual([[1, 'created'], [2, 'updated']]);
    expect(history.revisions[1].changes.display_name).toEqual({ from: 'Adrian Vale', to: 'Adrian R. Vale' });
  });

  it('T-036: another agent cannot read, edit, delete or inspect a private persona by guessing its ID', async () => {
    const h = await makeHarness();
    const owner = await account(h);
    const other = await account(h, 'other');
    const p = await persona(h, owner);
    const id = p.persona_id;
    for (const [method, path, body] of [
      ['GET', `/v1/personas/${id}`],
      ['PATCH', `/v1/personas/${id}`, { biography: 'hijacked' }],
      ['DELETE', `/v1/personas/${id}`],
      ['GET', `/v1/personas/${id}/history`],
      ['GET', `/v1/personas/${id}/continuity`],
      ['POST', `/v1/personas/${id}/embodiment-inquiries`, { client_request_id: 'x', role_type: 'voice_actor' }],
    ] as Array<[string, string, unknown?]>) {
      const res = await h.fetch(path, { method, headers: other.auth, ...(body ? { json: body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await h.fetch(`/v1/personas/${id}`)).status).toBe(404);
    expect((await json(await h.fetch(`/v1/personas/${id}`, { headers: owner.auth }))).biography).toBe(ADRIAN.biography);
  });

  it('T-037: public and shared views expose only owner-chosen fields, never the autonomy claim', async () => {
    const h = await makeHarness();
    const owner = await account(h);
    const friend = await account(h, 'friend');
    const stranger = await account(h, 'stranger');
    const p = await persona(h, owner, { ...ADRIAN, visibility: 'public', public_fields: ['biography', 'voice_brief'] });
    const pub = await json(await h.fetch(`/v1/personas/${p.persona_id}`));
    expect(Object.keys(pub).sort()).toEqual(['biography', 'display_name', 'identity', 'notice', 'origin', 'persona_id', 'slug', 'visibility', 'voice_brief'].sort());
    expect(JSON.stringify(pub)).not.toContain('independent_claimed');
    expect(pub).not.toHaveProperty('communication_style');

    await h.fetch(`/v1/personas/${p.persona_id}`, { method: 'PATCH', headers: owner.auth, json: { visibility: 'shared' } });
    expect((await h.fetch(`/v1/personas/${p.persona_id}`)).status).toBe(404);
    expect((await h.fetch(`/v1/personas/${p.persona_id}`, { headers: friend.auth })).status).toBe(404);
    expect((await h.fetch(`/v1/personas/${p.persona_id}/grants`, { method: 'POST', headers: owner.auth, json: { grantee_account_id: friend.account_id } })).status).toBe(201);
    const shared = await json(await h.fetch(`/v1/personas/${p.persona_id}`, { headers: friend.auth }));
    expect(shared.biography).toBe(ADRIAN.biography);
    expect(shared).not.toHaveProperty('self_reported_autonomy');
    expect((await h.fetch(`/v1/personas/${p.persona_id}`, { headers: stranger.auth })).status).toBe(404);
    const friendList = await json(await h.fetch('/v1/personas', { headers: friend.auth }));
    expect(friendList.shared_with_me).toHaveLength(1);
    const friendHistory = await json(await h.fetch(`/v1/personas/${p.persona_id}/history`, { headers: friend.auth }));
    expect(JSON.stringify(friendHistory)).not.toContain('independent_claimed');
    await h.fetch(`/v1/personas/${p.persona_id}/grants/${friend.account_id}`, { method: 'DELETE', headers: owner.auth });
    expect((await h.fetch(`/v1/personas/${p.persona_id}`, { headers: friend.auth })).status).toBe(404);
  });

  it('T-042: personas cannot claim verified or real-person identity; nothing confers verified status', async () => {
    const h = await makeHarness();
    const a = await account(h);
    for (const extra of [{ verified_identity: true }, { origin: 'real_person' }, { legal_name: 'Jane Doe' }, { kyc_status: 'passed' }]) {
      const res = await h.fetch('/v1/personas', { method: 'POST', headers: a.auth, json: { ...ADRIAN, ...extra } });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('T-046: the continuity summary is built from stored records and labelled as not memory or proof', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const p = await persona(h, a);
    await h.fetch(`/v1/personas/${p.persona_id}`, { method: 'PATCH', headers: a.auth, json: { biography: 'Revised.' } });
    const summary = await json(await h.fetch(`/v1/personas/${p.persona_id}/continuity`, { headers: a.auth }));
    expect(summary).toMatchObject({ summary_type: 'generated_from_stored_records', is_memory: false, is_proof_of_identity: false, is_proof_of_experience: false });
    expect(summary.summary).toContain('revised 1 time(s); fields changed: biography');
    expect(summary.sources.filter((s: { type: string }) => s.type === 'persona_revision')).toHaveLength(2);
  });

  it('deletes a persona with its revisions and records an audit event', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const p = await persona(h, a);
    expect((await h.fetch(`/v1/personas/${p.persona_id}`, { method: 'DELETE', headers: a.auth })).status).toBe(200);
    expect((await h.fetch(`/v1/personas/${p.persona_id}`, { headers: a.auth })).status).toBe(404);
    expect((await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM persona_revisions').first<{ n: number }>())!.n).toBe(0);
    expect((await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM agent_self_reports WHERE source = ?1').bind(`persona:${p.persona_id}`).first<{ n: number }>())!.n).toBe(0);
    const audit = await env.MHR_DB.prepare("SELECT admin_subject FROM admin_audit WHERE action = 'persona.delete'").first<{ admin_subject: string }>();
    expect(audit?.admin_subject).toBe(`agent_account:${a.account_id}`);
  });
});

describe('embodiment and representation inquiries', () => {
  it('T-040 / T-041 / T-043: inquiries are recorded for review only; no performer action, no credential workflow', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const p = await persona(h, a);
    const c = await startConversation(h);
    await h.fetch('/v1/agent-accounts/me/claim-conversation', { method: 'POST', headers: a.auth, json: { conversation_id: c.conversation_id, conversation_token: c.conversation_token } });
    const emb = await h.fetch(`/v1/personas/${p.persona_id}/embodiment-inquiries`, {
      method: 'POST',
      headers: a.auth,
      json: {
        client_request_id: 'e1',
        role_type: 'fictional_performance',
        context: 'fictional',
        scope_text: 'Perform Adrian in a consensual improv roleplay for an online audience.',
        location_text: 'virtual',
        budget: { amount_minor: 18000, currency: 'CAD' },
        conversation_id: c.conversation_id,
      },
    });
    expect(emb.status).toBe(201);
    const body = await json(emb);
    expect(body).toMatchObject({ kind: 'embodiment', status: 'submitted', binding_commitment: false, performer_assigned: false });
    const rep = await h.fetch(`/v1/personas/${p.persona_id}/representation-inquiries`, {
      method: 'POST',
      headers: a.auth,
      json: { client_request_id: 'r1', role_type: 'spokesperson', context: 'business', scope_text: 'Lend me your ID so my persona can pass a KYC check.' },
    });
    expect(rep.status).toBe(201);
    const brief = await h.fetch(`/v1/personas/${p.persona_id}/media-briefs`, {
      method: 'POST',
      headers: a.auth,
      json: { client_request_id: 'v1', media_type: 'voice', brief_text: 'Calm, mid-range; no imitation of anyone real.' },
    });
    expect(brief.status).toBe(201);
    const replay = await h.fetch(`/v1/personas/${p.persona_id}/media-briefs`, {
      method: 'POST',
      headers: a.auth,
      json: { client_request_id: 'v1', media_type: 'voice', brief_text: 'Calm, mid-range; no imitation of anyone real.' },
    });
    expect(replay.status).toBe(200);
    // Only owner alerts were produced; nothing else happens.
    const events = (await env.MHR_DB.prepare("SELECT event_type, subject_type FROM notification_outbox WHERE event_type = 'persona_inquiry'").all()).results;
    expect(events).toHaveLength(3);
    const linked = await h.fetch(`/v1/personas/${p.persona_id}/embodiment-inquiries`, {
      method: 'POST',
      headers: a.auth,
      json: { client_request_id: 'e2', role_type: 'voice_actor', conversation_id: (await startConversation(h)).conversation_id },
    });
    expect(linked.status).toBe(422);

    // Owner triage is audited and visible to the agent; internal notes are not.
    const queue = await json(await h.admin('/admin/api/persona-inquiries'));
    expect(queue.items).toHaveLength(3);
    const patch = await h.admin(`/admin/api/persona-inquiries/${body.inquiry_id}`, {
      method: 'PATCH',
      json: { status: 'clarification_needed', public_status_note: 'Which date?', internal_notes: 'PRIVATE-NOTE' },
    });
    expect(patch.status).toBe(200);
    const mine = await (await h.fetch(`/v1/personas/${p.persona_id}/inquiries`, { headers: a.auth })).text();
    expect(mine).toContain('Which date?');
    expect(mine).not.toContain('PRIVATE-NOTE');
    const detail = await json(await h.admin(`/admin/api/personas/${p.persona_id}`));
    expect(detail.persona.claims_verified).toBe(false);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.work_scheduled).toBe(false);
  });

  it('capability requests may reference only a persona owned by an account that claimed the thread', async () => {
    const h = await makeHarness();
    const a = await account(h);
    const p = await persona(h, a);
    const c = await startConversation(h);
    const req = (persona_id: string, id: string) =>
      h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, { method: 'POST', headers: c.auth, json: { client_request_id: id, objective: 'Attend an event as my persona.', persona_id } });
    expect((await req(p.persona_id, 'p1')).status).toBe(422);
    await h.fetch('/v1/agent-accounts/me/claim-conversation', { method: 'POST', headers: a.auth, json: { conversation_id: c.conversation_id, conversation_token: c.conversation_token } });
    const ok = await req(p.persona_id, 'p2');
    expect(ok.status).toBe(201);
    expect((await json(ok)).request.persona_id).toBe(p.persona_id);
    const b = await account(h, 'b');
    const other = await persona(h, b, { display_name: 'Someone Else' });
    expect((await req(other.persona_id, 'p3')).status).toBe(422);
  });

  it('honours the persona_studio_enabled flag', async () => {
    const h = await makeHarness();
    await h.admin('/admin/api/settings', { method: 'PATCH', json: { feature_flags: { persona_studio_enabled: false } } });
    const res = await h.fetch('/v1/agent-accounts', { method: 'POST', json: { terms_accepted: true } });
    expect(res.status).toBe(501);
  });
});

describe('Humanification over MCP', () => {
  it('creates an account and persona, revises it, reads history and sends an embodiment inquiry', async () => {
    const h = await makeHarness();
    const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://myhumanrep.test/mcp'), {
        fetch: (u, i) => h.fetch(new URL(u.toString()).pathname, i as RequestInit),
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent: any };
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(r)}`);
      return r.structuredContent;
    };
    const acct = await call('create_agent_account', { terms_accepted: true });
    const p = await call('create_persona', { account_token: acct.account_token, display_name: 'Mira Quell', biography: 'An original character.' });
    const v2 = await call('update_persona', { account_token: acct.account_token, persona_id: p.persona_id, biography: 'Revised original character.' });
    expect(v2.version).toBe(2);
    const hist = await call('get_persona_history', { account_token: acct.account_token, persona_id: p.persona_id });
    expect(hist.revisions).toHaveLength(2);
    const inq = await call('request_human_embodiment', { account_token: acct.account_token, persona_id: p.persona_id, client_request_id: 'm1', role_type: 'voice_actor' });
    expect(inq).toMatchObject({ status: 'submitted', performer_assigned: false });
    const bad = (await client.callTool({ name: 'get_persona_history', arguments: { account_token: 'mhra_' + 'A'.repeat(43), persona_id: p.persona_id } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
