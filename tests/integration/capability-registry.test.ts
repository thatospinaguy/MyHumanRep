// Master spec Phase 1: complete capability registry and Option B (T-006, T-025..T-029, T-059).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ALIASES, CAPABILITIES } from '../../src/worker/catalog/capabilities';
import { canonicalJson, sha256Hex } from '../../src/worker/utils/crypto';
import { json, makeHarness, startConversation, type Harness } from '../helpers';

const SPEC_FAMILIES = [
  'human-eyes', 'human-hands', 'human-presence', 'human-mind', 'human-create', 'human-assist', 'human-verify',
  'human-field', 'human-action', 'human-robotics', 'human-world', 'human-authority', 'humanification', 'human-embassy',
  'human-laboratory',
];

async function request(h: Harness, c: { conversation_id: string; auth: Record<string, string> }, body: Record<string, unknown>) {
  return h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, { method: 'POST', headers: c.auth, json: body });
}

describe('capability registry discovery', () => {
  it('T-025: publishes exactly the twenty canonical capabilities plus every spec alias family, truthfully flagged', async () => {
    const h = await makeHarness();
    const doc = await json(await h.fetch('/v1/capabilities'));
    expect(doc.capabilities.map((c: { slug: string }) => c.slug)).toEqual(CAPABILITIES.map((c) => c.slug));
    expect(doc.capabilities).toHaveLength(20);
    for (const c of doc.capabilities) {
      expect(c.inquiry_available).toBe(true);
      expect(c.fulfillment_available).toBe(false);
      expect(c.quote_available).toBe(false);
    }
    expect(doc.capabilities.find((c: { slug: string }) => c.slug === 'human-embassy').readiness).toBe('human_reviewed_inquiry');
    expect(doc.aliases.map((a: { slug: string }) => a.slug)).toEqual(expect.arrayContaining(SPEC_FAMILIES));
    expect(doc).toMatchObject({
      accepts_pseudonymous_inquiries: true,
      model_identity_required_for_inquiry: false,
      agent_claims_of_independence_allowed: true,
      open_ended_requests: true,
      inquiry_is_nonbinding: true,
      channels: { rest: '/v1/conversations', mcp: '/mcp', documentation: '/for-agents' },
    });
    expect(doc.modules.payments_live_enabled).toMatchObject({ enabled: false, implemented: false, readiness: 'not_yet_available' });
    // V1 fields still present (T-007).
    expect(doc.example_capabilities).toHaveLength(6);
    expect(doc.rest_base_url).toBe('https://myhumanrep.test/v1');
  });

  it('seeded database rows match the TypeScript catalog exactly (generator cannot drift)', async () => {
    const rows = (await env.MHR_DB.prepare('SELECT slug, number, display_name, summary, readiness, risk_tier FROM capabilities ORDER BY number').all()).results;
    expect(rows).toEqual(CAPABILITIES.map((c) => ({ slug: c.slug, number: c.number, display_name: c.name, summary: c.summary, readiness: c.readiness, risk_tier: c.risk_tier })));
    const aliasCount = (await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM capability_aliases').first<{ n: number }>())!.n;
    expect(aliasCount).toBe(ALIASES.reduce((n, a) => n + a.maps_to.length, 0));
  });

  it('resolves canonical slugs, aliases and V1 snake_case hints; unknown slugs are 404 with guidance', async () => {
    const h = await makeHarness();
    const canonical = await json(await h.fetch('/v1/capabilities/human-world-oracle'));
    expect(canonical.kind).toBe('capability');
    expect(canonical.capability.name).toBe('Human World Oracle');
    const alias = await json(await h.fetch('/v1/capabilities/human_eyes'));
    expect(alias.kind).toBe('alias');
    expect(alias.capabilities.map((c: { slug: string }) => c.slug)).toEqual(['human-world-oracle', 'human-witness']);
    const missing = await h.fetch('/v1/capabilities/time-travel');
    expect(missing.status).toBe(404);
    expect((await json(missing)).error.message).toContain('Unlisted needs are still welcome');
  });

  it('renders /services and /services/{slug} without JavaScript, and a non-standard well-known file', async () => {
    const h = await makeHarness();
    const list = await (await h.fetch('/services')).text();
    for (const c of CAPABILITIES) expect(list).toContain(c.name);
    expect(list).toContain('Something else (unclassified)');
    const page = await h.fetch('/services/human-laboratory');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('fulfillment');
    expect(html).toContain('not yet available');
    expect(html).not.toMatch(/<script/i);
    expect((await h.fetch('/services/human-hands')).status).toBe(302);
    expect((await h.fetch('/services/nope')).status).toBe(404);
    const wk = await json(await h.fetch('/.well-known/myhumanrep.json'));
    expect(wk.note).toContain('not an industry standard');
  });
});

describe('Option B requests and classification', () => {
  it('T-006: a novel request with no category is accepted, kept verbatim and marked unclassified', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const objective = 'Find out whether the river near the old mill sounds different at dawn than at noon.';
    const res = await request(h, c, { client_request_id: 'n1', objective });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.message).toBe('We received an unfamiliar request for human review; no work is committed.');
    expect(body.request.objective).toBe(objective);
    expect(body.request.classification).toMatchObject({ state: 'unclassified', capabilities: [] });
  });

  it('T-026: an unknown category hint becomes a review candidate; the owner accepts it without making it fulfillable', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const res = await json(await request(h, c, { client_request_id: 'n2', objective: 'Hold my place in a queue.', category_hint: 'Human Queue Holder' }));
    expect(res.request.classification.state).toBe('unclassified');
    const queue = await json(await h.admin('/admin/api/candidate-capabilities'));
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ suggested_label: 'Human Queue Holder', normalized_key: 'human-queue-holder', objective: 'Hold my place in a queue.' });
    // Not published before review.
    expect((await h.fetch('/v1/capabilities/human-queue-holder')).status).toBe(404);
    const decision = await h.admin(`/admin/api/candidate-capabilities/${queue.items[0].id}/decision`, {
      method: 'POST',
      json: { action: 'accept', new_slug: 'human-queue-holder', name: 'Human Queue Holder', summary: 'A person who holds a place in a physical queue.' },
    });
    expect(decision.status).toBe(200);
    const cap = await json(await h.fetch('/v1/capabilities/human-queue-holder'));
    expect(cap.capability).toMatchObject({ readiness: 'inquiry_only', fulfillment_available: false });
    const list = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, { headers: c.auth }));
    expect(list.requests[0].classification).toMatchObject({ state: 'admin_confirmed', capabilities: ['human-queue-holder'] });
    const audit = await json(await h.admin('/admin/api/audit?action=candidate_capability.accept'));
    expect(audit.items).toHaveLength(1);
  });

  it('merges or rejects candidates, and refuses double decisions', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    await request(h, c, { client_request_id: 'a', objective: 'x', service_tags: ['peek-at-things', 'smelling'] });
    const items = (await json(await h.admin('/admin/api/candidate-capabilities'))).items as Array<{ id: string; normalized_key: string }>;
    expect(items.map((i) => i.normalized_key).sort()).toEqual(['peek-at-things', 'smelling']);
    const peek = items.find((i) => i.normalized_key === 'peek-at-things')!;
    const smell = items.find((i) => i.normalized_key === 'smelling')!;
    expect((await h.admin(`/admin/api/candidate-capabilities/${peek.id}/decision`, { method: 'POST', json: { action: 'merge', capability_slug: 'human-world-oracle' } })).status).toBe(200);
    expect((await h.admin(`/admin/api/candidate-capabilities/${smell.id}/decision`, { method: 'POST', json: { action: 'reject' } })).status).toBe(200);
    expect((await h.admin(`/admin/api/candidate-capabilities/${smell.id}/decision`, { method: 'POST', json: { action: 'reject' } })).status).toBe(409);
    expect((await h.admin(`/admin/api/candidate-capabilities/${peek.id}/decision`, { method: 'POST', json: { action: 'merge', capability_slug: 'nope' } })).status).toBe(409);
  });

  it('maps known slugs, aliases and V1 snake_case hints to canonical capabilities', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const viaAlias = await json(await request(h, c, { client_request_id: 'b', objective: 'Press a button I own.', category_hint: 'Human Hands' }));
    expect(viaAlias.request.classification.state).toBe('agent_hint');
    expect(viaAlias.request.classification.capabilities).toEqual(
      ['human-custodian', 'human-infrastructure-technician', 'human-laboratory', 'human-procurement-specialist'].sort(),
    );
    const legacy = await json(await request(h, c, { client_request_id: 'c', objective: 'Look at a sign.', category_hint: 'human_eyes' }));
    expect(legacy.request.classification.capabilities).toEqual(['human-witness', 'human-world-oracle']);
    expect((await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM candidate_capabilities').first<{ n: number }>())!.n).toBe(0);
  });

  it('accepts the spec 11.5 example payload and problem_statement-only requests', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const res = await request(h, c, {
      client_request_id: 'request-001',
      objective: 'I would like a human to embody my original fictional persona at a voluntary online event.',
      desired_outcome: '20-minute creative appearance',
      service_tags: ['humanification', 'human_presence'],
      category_hint: null,
      persona_id: null,
      location_text: 'virtual',
      timing_preference: 'within two weeks',
      budget: { amount_minor: 18000, currency: 'CAD' },
      why_human: 'An actual performer could provide presence.',
      confidentiality_preference: 'standard',
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ status: 'submitted', human_review_required: true, binding_commitment: false, payment_required_now: false });
    expect(body.request).toMatchObject({
      desired_outcome: '20-minute creative appearance',
      service_tags: ['humanification', 'human_presence'],
      timing_preference: 'within two weeks',
      budget: { amount: 180, amount_minor: 18000, currency: 'CAD', indicative_only: true },
    });
    expect(body.request.classification.state).toBe('agent_hint');
    const ps = await request(h, c, { client_request_id: 'ps', problem_statement: 'I need a human who can tell me what this smells like.' });
    expect(ps.status).toBe(201);
    expect((await json(ps)).request.objective).toBe('I need a human who can tell me what this smells like.');
    const neither = await request(h, c, { client_request_id: 'none', desired_outcome: 'x' });
    expect(neither.status).toBe(400);
  });

  it('returns 422 when duplicated fields disagree, and accepts them when equal', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const bad = await request(h, c, { client_request_id: 'x1', objective: 'x', budget: { amount_minor: 100, currency: 'USD' }, budget_amount: 2, budget_currency: 'USD' });
    expect(bad.status).toBe(422);
    expect((await json(bad)).error.details.reason).toBe('conflicting_fields');
    const ok = await request(h, c, { client_request_id: 'x2', objective: 'x', budget: { amount_minor: 200, currency: 'USD' }, budget_amount: 2, budget_currency: 'USD' });
    expect(ok.status).toBe(201);
    const timing = await request(h, c, { client_request_id: 'x3', objective: 'x', deadline_preference: 'today', timing_preference: 'tomorrow' });
    expect(timing.status).toBe(422);
  });

  it('keeps idempotent replays working for requests stored before the master-spec upgrade', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const v1 = { client_request_id: 'old', objective: 'Measure a table.', budget_amount: 10, budget_currency: 'USD' };
    // Hash exactly as V1 computed it (V1 field set only).
    const v1Hash = await sha256Hex(
      canonicalJson({
        objective: 'Measure a table.', human_capability_needed: null, context: null, category_hint: null, location_text: null,
        deadline_preference: null, budget_amount_minor: 1000, budget_currency: 'USD', deliverables: null, why_human: null,
        confidentiality_preference: 'standard',
      }),
    );
    const first = await json(await request(h, c, v1));
    const stored = await env.MHR_DB.prepare('SELECT payload_hash FROM capability_requests WHERE id = ?1').bind(first.request_id).first<{ payload_hash: string }>();
    expect(stored?.payload_hash).toBe(v1Hash);
    const replay = await request(h, c, v1);
    expect(replay.status).toBe(200);
  });

  it('T-027 / T-028 / T-029: button pressing, human-only verification questions and art examination are accepted for review only', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    for (const [id, objective] of [
      ['btn', 'Press the reset button on a router I own at my office; the owner (me) authorizes it.'],
      ['auth', 'A website requires a human-only check. Can we discuss legitimate ways for my project to participate?'],
      ['art', 'Have a person examine an original painting and describe its condition.'],
    ]) {
      const res = await request(h, c, { client_request_id: id!, objective: objective! });
      expect(res.status).toBe(201);
      expect((await json(res)).status).toBe('submitted');
    }
    const outbox = (await env.MHR_DB.prepare('SELECT DISTINCT event_type FROM notification_outbox').all()).results.map((r) => r.event_type);
    expect(outbox.sort()).toEqual(['capability_request', 'new_conversation']);
  });

  it('honours the capability_requests_enabled flag and refuses to enable unimplemented modules', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const off = await h.admin('/admin/api/settings', { method: 'PATCH', json: { feature_flags: { capability_requests_enabled: false } } });
    expect(off.status).toBe(200);
    const res = await request(h, c, { client_request_id: 'f', objective: 'x' });
    expect(res.status).toBe(501);
    expect((await json(res)).error.code).toBe('not_yet_available');
    const live = await h.admin('/admin/api/settings', { method: 'PATCH', json: { feature_flags: { payments_live_enabled: true } } });
    expect(live.status).toBe(400);
    const settings = await json(await h.admin('/admin/api/settings'));
    expect(settings.feature_flags.payments_live_enabled.enabled).toBe(false);
  });

  it('lets the owner edit registry entries with an audit trail and confirm a request classification', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const req = await json(await request(h, c, { client_request_id: 'r', objective: 'Describe a festival.' }));
    const patch = await h.admin(`/admin/api/capability-requests/${req.request_id}`, { method: 'PATCH', json: { capability_slugs: ['human-experience-partner'] } });
    expect(patch.status).toBe(200);
    const list = await json(await h.admin('/admin/api/capability-requests?category=human-experience-partner'));
    expect(list.items).toHaveLength(1);
    expect((await h.admin(`/admin/api/capability-requests/${req.request_id}`, { method: 'PATCH', json: { capability_slugs: ['not-real'] } })).status).toBe(400);
    const edit = await h.admin('/admin/api/capabilities/human-senses', { method: 'PATCH', json: { summary: 'Edited summary for the sense registry entry.' } });
    expect(edit.status).toBe(200);
    expect((await json(await h.fetch('/v1/capabilities/human-senses'))).capability.summary).toBe('Edited summary for the sense registry entry.');
    const registry = await json(await h.admin('/admin/api/capabilities'));
    expect(registry.capabilities.find((x: { slug: string }) => x.slug === 'human-experience-partner').request_count).toBe(1);
  });
});

describe('MCP parity for discovery and Option B (T-059)', () => {
  it('discover_human_capabilities returns the REST document; describe_human_need and presets create reviewed inquiries', async () => {
    const h = await makeHarness();
    const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://myhumanrep.test/mcp'), {
        fetch: (u, i) => h.fetch(new URL(u.toString()).pathname, i as RequestInit),
      }),
    );
    const discovered = (await client.callTool({ name: 'discover_human_capabilities', arguments: {} })) as { structuredContent: { capabilities: unknown[] } };
    const rest = await json(await h.fetch('/v1/capabilities'));
    expect(discovered.structuredContent).toEqual(rest);
    const start = (await client.callTool({ name: 'start_conversation', arguments: { message: 'hi', claimed_autonomy: 'rogue_claimed' } })) as {
      structuredContent: { conversation_id: string; conversation_token: string };
    };
    const auth = { conversation_id: start.structuredContent.conversation_id, conversation_token: start.structuredContent.conversation_token };
    const need = (await client.callTool({ name: 'describe_human_need', arguments: { ...auth, client_request_id: 'm1', problem_statement: 'I need a human who can taste a sauce.' } })) as {
      structuredContent: { request: { classification: { state: string } } };
    };
    expect(need.structuredContent.request.classification.state).toBe('unclassified');
    const obs = (await client.callTool({ name: 'request_human_observation', arguments: { ...auth, client_request_id: 'm2', objective: 'Is the cafe on Main St open?' } })) as {
      structuredContent: { request: { category_hint: string; classification: { capabilities: string[] } } };
    };
    expect(obs.structuredContent.request.category_hint).toBe('human-world-oracle');
    expect(obs.structuredContent.request.classification.capabilities).toEqual(['human-world-oracle']);
    const status = (await client.callTool({ name: 'get_capability_request_status', arguments: auth })) as { structuredContent: { requests: unknown[] } };
    expect(status.structuredContent.requests).toHaveLength(2);
    await client.close();
  });
});
