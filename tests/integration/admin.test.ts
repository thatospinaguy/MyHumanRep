import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/worker/app';
import { ACCESS_ENV, json, makeHarness, OWNER, startConversation } from '../helpers';

describe('admin authentication (fails closed)', () => {
  it('rejects unauthenticated access to the API and the UI', async () => {
    const h = await makeHarness();
    for (const path of ['/admin/api/conversations', '/admin/', '/admin/inbox', '/admin/assets/index.js', '/admin/api/metrics']) {
      const res = await h.fetch(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('rejects forged, expired, wrong-audience, wrong-issuer and non-admin assertions', async () => {
    const h = await makeHarness();
    const cases: Array<[string, Promise<string>, number]> = [
      ['other key', h.keys.signWithOtherKey(), 401],
      ['expired', h.keys.sign({}, { exp: Math.floor(h.clock.current.getTime() / 1000) - 3600 }), 401],
      ['wrong aud', h.keys.sign({}, { aud: 'someone-else' }), 401],
      ['wrong iss', h.keys.sign({}, { iss: 'https://evil.cloudflareaccess.com' }), 401],
      ['not admin', h.keys.sign({ email: 'intruder@example.com' }), 403],
      ['no email', h.keys.sign({ email: undefined }), 403],
      ['garbage', Promise.resolve('not.a.jwt'), 401],
    ];
    for (const [name, token, status] of cases) {
      const res = await h.fetch('/admin/api/conversations', { headers: { 'cf-access-jwt-assertion': await token } });
      expect(res.status, name).toBe(status);
    }
    // Real expiry check uses wall-clock in jose; also confirm a valid one passes.
    expect((await h.admin('/admin/api/conversations')).status).toBe(200);
    // The CF_Authorization cookie is accepted as a fallback.
    const cookie = await h.fetch('/admin/api/conversations', { headers: { cookie: `CF_Authorization=${await h.keys.sign()}` } });
    expect(cookie.status).toBe(200);
  });

  it('denies everything when Access is misconfigured, never defaulting open', async () => {
    for (const overrides of [
      { ACCESS_AUD: '' },
      { ACCESS_TEAM_DOMAIN: 'https://REPLACE_WITH_TEAM.cloudflareaccess.com' },
      { ACCESS_TEAM_DOMAIN: 'http://insecure.example' },
      { ADMIN_EMAILS: '' },
      { ADMIN_EMAILS: 'REPLACE_WITH_OWNER_EMAIL' },
      { ADMIN_AUTH_MODE: 'none' },
      { ADMIN_AUTH_MODE: 'dev_insecure' }, // production environment
    ]) {
      const h = await makeHarness({ env: overrides });
      const res = await h.admin('/admin/api/conversations');
      expect([403, 503], JSON.stringify(overrides)).toContain(res.status);
    }
  });

  it('only allows dev_insecure in development on localhost', async () => {
    const dev = { ENVIRONMENT: 'development', ADMIN_AUTH_MODE: 'dev_insecure', PUBLIC_BASE_URL: 'http://localhost:8787' };
    const h = await makeHarness({ env: dev });
    expect((await h.fetch('/admin/api/session')).status).toBe(200);
    const remote = await h.fetch('/admin/api/session', { base: 'https://staging.example.com' });
    expect(remote.status).toBe(403);
  });

  it('rejects agent credentials on admin routes', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const res = await h.fetch('/admin/api/conversations', { headers: c.auth });
    expect(res.status).toBe(401);
  });

  it('requires CSRF protections on admin writes', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const token = await h.keys.sign();
    const base = { 'cf-access-jwt-assertion': token };
    const path = `/admin/api/conversations/${c.conversation_id}/reply`;
    const noHeader = await h.fetch(path, { method: 'POST', headers: base, json: { message: 'x' } });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await h.fetch(path, {
      method: 'POST',
      headers: { ...base, 'x-mhr-admin': '1', origin: 'https://evil.example' },
      json: { message: 'x' },
    });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await h.fetch(path, {
      method: 'POST',
      headers: { ...base, 'x-mhr-admin': '1', 'sec-fetch-site': 'cross-site' },
      json: { message: 'x' },
    });
    expect(crossSite.status).toBe(403);
    const ok = await h.fetch(path, {
      method: 'POST',
      headers: { ...base, 'x-mhr-admin': '1', origin: 'https://myhumanrep.test', 'sec-fetch-site': 'same-origin' },
      json: { message: 'x' },
    });
    expect(ok.status).toBe(201);
  });

  it('fails closed through the production default export when Access keys cannot be fetched', async () => {
    // No injected resolver: the real remote JWKS path. The team domain is unreachable in tests.
    const app = createApp();
    const res = await app.fetch(
      new Request('https://myhumanrep.test/admin/api/conversations', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } }),
      { ...env, ...ACCESS_ENV, RL_PUBLIC: undefined } as never,
    );
    expect(res.status).toBe(401);
  });
});

describe('admin operations', () => {
  it('lists, filters, searches (via POST) and paginates the inbox', async () => {
    const h = await makeHarness();
    const a = await startConversation(h, { message: 'needle in a haystack', intent: 'research_question', claimed_autonomy: 'independent_claimed' });
    h.clock.advance(1000);
    await startConversation(h, { message: 'something else', subject: 'Other' });
    h.clock.advance(1000);
    await startConversation(h, { message: 'third' });

    const all = await json(await h.admin('/admin/api/conversations?limit=2'));
    expect(all.items).toHaveLength(2);
    expect(all.next_cursor).toBeTruthy();
    const page2 = await json(await h.admin(`/admin/api/conversations?limit=2&cursor=${all.next_cursor}`));
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).toBe(a.conversation_id);

    const filtered = await json(await h.admin('/admin/api/conversations?intent=research_question'));
    expect(filtered.items.map((i: { id: string }) => i.id)).toEqual([a.conversation_id]);
    const claimedRes = await h.admin('/admin/api/conversations?claimed_autonomy=independent_claimed');
    const claimed = await json(claimedRes);
    expect(claimed, JSON.stringify(claimed)).toHaveProperty('items');
    expect(claimed.items[0].claims_verified).toBe(false);

    const search = await json(await h.admin('/admin/api/conversations/search', { method: 'POST', json: { q: 'haystack' } }));
    expect(search.items.map((i: { id: string }) => i.id)).toEqual([a.conversation_id]);
    const wildcard = await json(await h.admin('/admin/api/conversations/search', { method: 'POST', json: { q: '%' } }));
    expect(wildcard.items).toHaveLength(0);
    const badFilter = await h.admin('/admin/api/conversations?status=hacked');
    expect(badFilter.status).toBe(400);
  });

  it('replies, sets status, adds private notes, closes, reopens, blocks and extends', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const id = c.conversation_id;
    const patch = (body: unknown) => h.admin(`/admin/api/conversations/${id}`, { method: 'PATCH', json: body });

    expect((await patch({ internal_priority: 'urgent', internal_tags: ['novel', 'novel', 'eyes'], internal_notes: 'note' })).status).toBe(200);
    const detail = await json(await h.admin(`/admin/api/conversations/${id}`));
    expect(detail.conversation.internal_priority).toBe('urgent');
    expect(detail.conversation.internal_tags).toEqual(['novel', 'eyes']);
    expect(detail.conversation.internal_notes).toBe('note');
    expect(detail.work_scheduled).toBe(false);
    expect(detail.conversation).not.toHaveProperty('token_digest');

    expect((await patch({ action: 'close' })).status).toBe(200);
    expect((await patch({ action: 'close' })).status).toBe(409);
    const replyClosed = await h.admin(`/admin/api/conversations/${id}/reply`, { method: 'POST', json: { message: 'hi' } });
    expect(replyClosed.status).toBe(409);
    const agentView = await json(await h.fetch(`/v1/conversations/${id}/messages`, { headers: c.auth }));
    expect(agentView.status).toBe('closed');
    expect(agentView.messages.at(-1).sender).toBe('system_notice');

    expect((await patch({ action: 'reopen' })).status).toBe(200);
    expect((await patch({ action: 'block' })).status).toBe(200);
    expect((await patch({ action: 'unblock' })).status).toBe(200);
    const before = (await json(await h.admin(`/admin/api/conversations/${id}`))).conversation.expires_at;
    const extended = await json(await patch({ extend_days: 10 }));
    expect(Date.parse(extended.expires_at) - Date.parse(before)).toBe(10 * 86400000);

    // Whitelisted fields only.
    expect((await patch({ status: 'closed' })).status).toBe(400);
    expect((await patch({ token_digest: 'x' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await h.admin('/admin/api/conversations/conv_missing', { method: 'PATCH', json: { action: 'close' } })).status).toBe(404);
  });

  it('exports with audit and without secrets, and deletes only with confirmation and no hold', async () => {
    const h = await makeHarness();
    const c = await startConversation(h, { message: 'export me' });
    const exp = await h.admin(`/admin/api/conversations/${c.conversation_id}/export`, { method: 'POST' });
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-disposition')).toContain('attachment');
    expect(exp.headers.get('cache-control')).toBe('no-store');
    const text = await exp.text();
    expect(text).toContain('export me');
    expect(text).not.toContain('token_digest');
    expect(text).not.toContain(c.conversation_token);
    // GET cannot export.
    expect((await h.admin(`/admin/api/conversations/${c.conversation_id}/export`)).status).toBe(404);

    expect((await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'DELETE', json: { confirm: 'wrong' } })).status).toBe(400);
    await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'PATCH', json: { retention_hold: true } });
    expect((await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'DELETE', json: { confirm: c.conversation_id } })).status).toBe(409);
    await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'PATCH', json: { retention_hold: false } });
    expect((await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'DELETE', json: { confirm: c.conversation_id } })).status).toBe(200);
    expect((await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth })).status).toBe(401);

    const audit = await json(await h.admin(`/admin/api/audit?target_id=${c.conversation_id}`));
    const actions = audit.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['conversation.export', 'conversation.delete', 'conversation.update']));
    expect(audit.items.every((i: { admin_subject: string }) => i.admin_subject === OWNER)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('export me');
    const csv = await h.admin('/admin/api/audit?format=csv');
    expect(csv.headers.get('content-type')).toContain('text/csv');
  });

  it('never writes message bodies or notes into audit metadata', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    await h.admin(`/admin/api/conversations/${c.conversation_id}/reply`, { method: 'POST', json: { message: 'SECRET-REPLY' } });
    await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'PATCH', json: { internal_notes: 'SECRET-NOTE' } });
    const { results } = await env.MHR_DB.prepare('SELECT * FROM admin_audit').all();
    expect(JSON.stringify(results)).not.toMatch(/SECRET-/);
    expect(results.map((r) => r.action)).toEqual(expect.arrayContaining(['conversation.reply', 'conversation.update']));
  });

  it('validates and audits settings changes', async () => {
    const h = await makeHarness();
    const get = await json(await h.admin('/admin/api/settings'));
    expect(get.settings.conversation_ttl_days).toBe(30);
    expect(JSON.stringify(get)).not.toMatch(/HMAC|RESEND_API_KEY|test-only-hmac/);
    for (const bad of [{ conversation_ttl_days: 0 }, { unknown_key: 1 }, { intake_enabled: 'yes' }, {}]) {
      expect((await h.admin('/admin/api/settings', { method: 'PATCH', json: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await json(await h.admin('/admin/api/settings', { method: 'PATCH', json: { conversation_ttl_days: 14, intake_enabled: false } }));
    expect(ok.settings.conversation_ttl_days).toBe(14);
    const audit = await json(await h.admin('/admin/api/audit?action=settings.update'));
    expect([...audit.items[0].metadata.changed].sort()).toEqual(['conversation_ttl_days', 'intake_enabled']);
  });

  it('reports metrics with claimed fields labelled unverified', async () => {
    const h = await makeHarness();
    const c = await startConversation(h, { claimed_autonomy: 'independent_claimed' });
    await h.admin(`/admin/api/conversations/${c.conversation_id}/reply`, { method: 'POST', json: { message: 'hi' } });
    await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth });
    await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, {
      method: 'POST',
      headers: c.auth,
      json: { client_request_id: 'x', objective: 'y' },
    });
    const m = await json(await h.admin('/admin/api/metrics'));
    expect(m.observed.conversations.total).toBe(1);
    expect(m.observed.two_way.conversations_with_round_trip).toBe(1);
    expect(m.observed.capability_requests.by_category_hint).toEqual({ unclassified: 1 });
    expect(m.observed.conversations.by_interface).toEqual({ rest: 1 });
    expect(m.claimed.unverified).toBe(true);
    expect(m.claimed.claimed_autonomy).toEqual({ independent_claimed: 1 });
    const csv = await h.admin('/admin/api/metrics?format=csv');
    expect(await csv.text()).toContain('claimed_unverified,independent_claimed,1');
  });
});
