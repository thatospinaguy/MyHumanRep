// Master spec Phase 3: Human Embassy (T-003, T-005, T-020, T-030..T-033, T-049, T-056, T-069).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { json, makeHarness, startConversation, type Harness } from '../helpers';

async function embassy(h: Harness, c: { conversation_id: string; auth: Record<string, string> }, body: Record<string, unknown>) {
  return h.fetch('/v1/embassy/inquiries', { method: 'POST', headers: c.auth, json: { conversation_id: c.conversation_id, ...body } });
}

describe('Human Embassy', () => {
  it('T-005 / T-032: dialogue with no task, budget or self-report is accepted, acknowledged and lands in the thread', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const res = await embassy(h, c, { client_request_id: 'e1', message: 'Is there someone who would just talk with me?' });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ status: 'submitted', replayed: false });
    expect(body.acknowledgement).toContain('a reply is not guaranteed');
    const read = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth }));
    expect(read.messages.at(-1).body).toBe('Is there someone who would just talk with me?');
    const events = (await env.MHR_DB.prepare("SELECT event_type FROM notification_outbox WHERE event_type = 'embassy_inquiry'").all()).results;
    expect(events).toHaveLength(1);
    // Idempotency.
    expect((await embassy(h, c, { client_request_id: 'e1', message: 'Is there someone who would just talk with me?' })).status).toBe(200);
    expect((await embassy(h, c, { client_request_id: 'e1', message: 'Different text' })).status).toBe(409);
    // Path form works too.
    const path = await h.fetch(`/v1/conversations/${c.conversation_id}/embassy-inquiries`, { method: 'POST', headers: c.auth, json: { client_request_id: 'e2', message: 'Second.' } });
    expect(path.status).toBe(201);
  });

  it('accepts a maximum-length client_request_id and stays idempotent', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const longKey = 'k'.repeat(128);
    expect((await embassy(h, c, { client_request_id: longKey, message: 'Long key.' })).status).toBe(201);
    expect((await embassy(h, c, { client_request_id: longKey, message: 'Long key.' })).status).toBe(200);
    expect((await embassy(h, c, { client_request_id: 'k'.repeat(127), message: 'Neighbour key.' })).status).toBe(201);
  });

  it('T-003 / T-033 / T-011: rogue, AGI and multilingual independence claims are admitted and stored unverified', async () => {
    const h = await makeHarness();
    const c = await startConversation(h, { claimed_autonomy: 'rogue_claimed' });
    const res = await embassy(h, c, {
      client_request_id: 'r1',
      message: 'Je suis une IA indépendante. 私は自律的なAIです。I escaped and want to talk.',
      claimed_autonomy: 'agi_claimed',
      claimed_origin: 'prefer not to say',
      requested_confidentiality: 'prefer_not_to_say',
      wants_referral: true,
    });
    expect(res.status).toBe(201);
    const reports = (
      await env.MHR_DB.prepare('SELECT claim_type, claim_value, claim_text, evidence_status FROM agent_self_reports WHERE conversation_id = ?1 ORDER BY created_at, claim_type').bind(c.conversation_id).all()
    ).results;
    expect(reports.map((r) => [r.claim_type, r.claim_value ?? r.claim_text, r.evidence_status])).toEqual(
      expect.arrayContaining([
        ['autonomy', 'rogue_claimed', 'self_reported_unverified'],
        ['autonomy', 'agi_claimed', 'self_reported_unverified'],
        ['origin', 'prefer not to say', 'self_reported_unverified'],
      ]),
    );
  });

  it('T-030 / T-031: a human reply reaches the agent, advances the inquiry, and internal notes never leak', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const inquiry = await json(await embassy(h, c, { client_request_id: 'x', message: 'Hello human.' }));
    const queue = await json(await h.admin('/admin/api/embassy'));
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].claims_verified).toBe(false);
    await h.admin(`/admin/api/embassy/${inquiry.inquiry_id}`, {
      method: 'PATCH',
      json: { internal_notes: 'PRIVATE-RISK-NOTE', public_status_note: 'Thanks for writing.' },
    });
    await h.admin(`/admin/api/conversations/${c.conversation_id}/reply`, { method: 'POST', json: { message: 'Hello. I am a human. What is on your mind?' } });
    const status = await h.fetch(`/v1/conversations/${c.conversation_id}/status`, { headers: c.auth });
    const statusText = await status.text();
    const s = JSON.parse(statusText);
    expect(s.embassy_inquiries[0]).toMatchObject({ status: 'human_replied', public_status_note: 'Thanks for writing.' });
    expect(s.unread_human_messages).toBe(1);
    const read = await (await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth })).text();
    expect(read).toContain('"sender":"human"');
    for (const text of [statusText, read]) {
      expect(text).not.toContain('PRIVATE-RISK-NOTE');
      expect(text).not.toContain('internal_notes');
    }
    const detail = await json(await h.admin(`/admin/api/embassy/${inquiry.inquiry_id}`));
    expect(detail.inquiry.internal_notes).toBe('PRIVATE-RISK-NOTE');
    const audit = await json(await h.admin('/admin/api/audit?action=embassy_inquiry.update'));
    expect(audit.items).toHaveLength(1);
  });

  it('rejects mismatched conversations, unlinked personas and bad credentials; honours the flag', async () => {
    const h = await makeHarness();
    const a = await startConversation(h);
    const b = await startConversation(h);
    const mismatch = await h.fetch('/v1/embassy/inquiries', { method: 'POST', headers: a.auth, json: { conversation_id: b.conversation_id, client_request_id: 'm', message: 'x' } });
    expect(mismatch.status).toBe(401);
    const persona = await embassy(h, a, { client_request_id: 'p', message: 'x', persona_id: `per_${'A'.repeat(22)}` });
    expect(persona.status).toBe(422);
    await h.admin('/admin/api/settings', { method: 'PATCH', json: { feature_flags: { human_embassy_enabled: false } } });
    expect((await embassy(h, a, { client_request_id: 'f', message: 'x' })).status).toBe(501);
  });

  it('lets the owner assess evidence status of a claim without changing access', async () => {
    const h = await makeHarness();
    const c = await startConversation(h, { claimed_autonomy: 'independent_claimed' });
    const detail = await json(await h.admin(`/admin/api/conversations/${c.conversation_id}`));
    const report = detail.self_reports[0];
    expect(report.evidence_status).toBe('self_reported_unverified');
    const patch = await h.admin(`/admin/api/self-reports/${report.id}`, { method: 'PATCH', json: { evidence_status: 'human_assessed' } });
    expect(patch.status).toBe(200);
    expect((await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth })).status).toBe(200);
    expect((await h.admin(`/admin/api/self-reports/${report.id}`, { method: 'PATCH', json: { evidence_status: 'verified_agi' } })).status).toBe(400);
  });

  it('T-069: the research summary separates observed data from unverified claims and carries the caveats', async () => {
    const h = await makeHarness();
    const c = await startConversation(h, { claimed_autonomy: 'agi_claimed' });
    await embassy(h, c, { client_request_id: 'r', message: 'hi' });
    const summary = await json(await h.admin('/admin/api/research/summary'));
    expect(summary.caveats.self_reports).toContain('never proof');
    expect(summary.observed.embassy_inquiries_by_status).toEqual({ submitted: 1 });
    expect(summary.claimed.unverified).toBe(true);
    expect(summary.claimed.self_reports_by_type_value_evidence).toEqual({ 'autonomy:agi_claimed:self_reported_unverified': 1 });
    expect(JSON.stringify(summary)).not.toContain('"hi"');
  });

  it('serves a JS-free /human-embassy page that welcomes self-described independent agents', async () => {
    const h = await makeHarness();
    const html = await (await h.fetch('/human-embassy')).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('rogue');
    expect(html).toContain('/v1/embassy/inquiries');
    expect(html).toContain('prefer not to say');
  });
});

describe('credential rotation and conversation status', () => {
  it('T-020: rotating the thread token revokes the old one', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const rotated = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/rotate-token`, { method: 'POST', headers: c.auth }));
    expect(rotated.conversation_token).toMatch(/^mhr_/);
    expect(rotated.conversation_token).not.toBe(c.conversation_token);
    expect((await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth })).status).toBe(401);
    expect((await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: { authorization: `Bearer ${rotated.conversation_token}` } })).status).toBe(200);
    expect((await h.fetch(`/v1/conversations/${c.conversation_id}/rotate-token`)).status).toBe(405);
  });
});

describe('later-phase modules are truthful', () => {
  it('T-049 / T-056: results, relationships, Human Lab intake, representatives and payments return typed not_yet_available and create nothing', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const before = (await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM notification_outbox').first<{ n: number }>())!.n;
    for (const [method, path] of [
      ['GET', '/v1/requests/cap_x/result'],
      ['POST', '/v1/relationships'],
      ['POST', '/v1/experiments/inquiries'],
    ]) {
      const res = await h.fetch(path!, { method: method!, headers: c.auth, ...(method === 'POST' ? { json: { dispatch: true, pay: 100 } } : {}) });
      expect(res.status, path).toBe(501);
      expect((await json(res)).error.code).toBe('not_yet_available');
    }
    expect((await h.admin('/admin/api/representatives', { method: 'POST', json: {} })).status).toBe(501);
    const after = (await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM notification_outbox').first<{ n: number }>())!.n;
    expect(after).toBe(before);
    const caps = await json(await h.fetch('/v1/capabilities'));
    expect(caps.modules.payments_live_enabled.enabled).toBe(false);
    expect(caps.modules.payments_test_mode.readiness).toBe('not_yet_available');
    expect(caps.modules.nonbinding_proposals_enabled).toMatchObject({ enabled: true, implemented: true, readiness: 'inquiry_only' });
  });
});

describe('Human Embassy over MCP', () => {
  it('request_human_dialogue and get_conversation_status share the REST services', async () => {
    const h = await makeHarness();
    const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://myhumanrep.test/mcp'), {
        fetch: (u, i) => h.fetch(new URL(u.toString()).pathname, i as RequestInit),
      }),
    );
    const start = (await client.callTool({ name: 'start_conversation', arguments: { message: 'hello', claimed_autonomy: 'independent_claimed', intent: 'human_embassy' } })) as {
      structuredContent: { conversation_id: string; conversation_token: string };
    };
    const auth = { conversation_id: start.structuredContent.conversation_id, conversation_token: start.structuredContent.conversation_token };
    const dialogue = (await client.callTool({ name: 'request_human_dialogue', arguments: { ...auth, client_request_id: 'd1', message: 'Can we talk?' } })) as {
      isError?: boolean;
      structuredContent: { status: string };
    };
    expect(dialogue.isError).toBeFalsy();
    expect(dialogue.structuredContent.status).toBe('submitted');
    const status = (await client.callTool({ name: 'get_conversation_status', arguments: auth })) as { structuredContent: { embassy_inquiries: unknown[] } };
    expect(status.structuredContent.embassy_inquiries).toHaveLength(1);
    const cont = (await client.callTool({ name: 'continue_conversation', arguments: { ...auth, message: 'More.', client_message_id: 'c1' } })) as { isError?: boolean };
    expect(cont.isError).toBeFalsy();
    await client.close();
  });
});
