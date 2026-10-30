import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { json, makeHarness, startConversation, type Harness } from '../helpers';

async function submit(h: Harness, c: { conversation_id: string; auth: Record<string, string> }, body: Record<string, unknown>) {
  return h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, { method: 'POST', headers: c.auth, json: body });
}

describe('open-ended capability requests', () => {
  it('accepts arbitrary objectives with no, known, or novel category hints', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    for (const [i, hint] of [undefined, 'human_eyes', 'smell_a_flower', 'other'].entries()) {
      const res = await submit(h, c, { client_request_id: `r${i}`, objective: `Objective number ${i}`, ...(hint ? { category_hint: hint } : {}) });
      expect(res.status).toBe(201);
      expect((await json(res)).request.category_hint).toBe(hint ?? null);
    }
  });

  it('validates location, deadline and budget and stores integer minor units', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const ok = await submit(h, c, {
      client_request_id: 'b1',
      objective: 'Measure a table.',
      location_text: 'Toronto, Ontario',
      deadline_preference: '2026-11-05T17:00:00-05:00',
      budget_amount: 199.99,
      budget_currency: 'CAD',
    });
    expect(ok.status).toBe(201);
    const row = await env.MHR_DB.prepare('SELECT budget_amount_minor, budget_currency FROM capability_requests').first();
    expect(row).toEqual({ budget_amount_minor: 19999, budget_currency: 'CAD' });
    const yen = await submit(h, c, { client_request_id: 'b2', objective: 'x', budget_amount: 5000, budget_currency: 'JPY' });
    expect((await json(yen)).request.budget.amount_minor).toBe(5000);

    for (const bad of [
      { budget_amount: 1.5, budget_currency: 'JPY' },
      { budget_amount: 10 },
      { budget_currency: 'USD' },
      { budget_amount: '10', budget_currency: 'USD' },
      { budget_amount: -5, budget_currency: 'USD' },
      { location_text: 'line\nbreak' },
      { deadline_preference: 'x'.repeat(151) },
      { confidentiality_preference: 'secret_from_operator' },
      { objective: '' },
    ]) {
      const res = await submit(h, c, { client_request_id: `bad-${Math.random()}`, objective: 'x', ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('is idempotent on identical payloads and rejects conflicting reuse', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const body = { client_request_id: 'same', objective: 'Do a thing', budget_amount: 10, budget_currency: 'USD' };
    const first = await submit(h, c, body);
    expect(first.status).toBe(201);
    // Key order and explicit nulls do not change the canonical payload.
    const replay = await submit(h, c, { budget_currency: 'USD', objective: 'Do a thing', budget_amount: 10, client_request_id: 'same', context: null });
    expect(replay.status).toBe(200);
    expect((await json(replay)).replayed).toBe(true);
    const conflict = await submit(h, c, { ...body, objective: 'Do another thing' });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.details.reason).toBe('client_request_id_reused');
    const count = await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM capability_requests').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('exposes only public fields and owner-intended notes to the agent', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const cap = await json(await submit(h, c, { client_request_id: 'p', objective: 'Observe a bird feeder.' }));
    await h.admin(`/admin/api/capability-requests/${cap.request_id}`, {
      method: 'PATCH',
      json: {
        status: 'needs_authorization',
        internal_notes: 'PRIVATE: possible trespass risk',
        internal_category: 'PRIVATE-taxonomy',
        public_status_note: 'We need to confirm you are authorized to request access to this property.',
      },
    });
    await h.admin(`/admin/api/conversations/${c.conversation_id}`, {
      method: 'PATCH',
      json: { internal_notes: 'PRIVATE conversation note', internal_tags: ['PRIVATE-tag'], internal_priority: 'high', under_review: true },
    });
    const list = await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, { headers: c.auth });
    const msgs = await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth });
    const text = (await list.text()) + (await msgs.text());
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain('internal_');
    expect(text).not.toContain('token_digest');
    expect(text).toContain('confirm you are authorized');
  });

  it('declines with a public explanation and schedules nothing', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const cap = await json(await submit(h, c, { client_request_id: 'd', objective: 'Pretend to be my operator on a phone call.' }));
    const res = await h.admin(`/admin/api/capability-requests/${cap.request_id}`, { method: 'PATCH', json: { status: 'declined' } });
    expect(res.status).toBe(200);
    const list = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, { headers: c.auth }));
    expect(list.requests[0].status).toBe('declined');
    expect(list.requests[0].public_status_note).toMatch(/No work will be performed/);
    expect(list.requests[0].binding_commitment).toBe(false);
    const declinedAgain = await h.admin(`/admin/api/capability-requests/${cap.request_id}`, {
      method: 'PATCH',
      json: { status: 'eligible_for_future_scoping' },
    });
    expect(declinedAgain.status).toBe(409);
    expect((await json(declinedAgain)).error.details.allowed).toEqual(['triaging']);
  });

  it('posts an optional agent-visible message atomically with a decision', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const cap = await json(await submit(h, c, { client_request_id: 'm', objective: 'Attend a meetup.' }));
    const res = await json(
      await h.admin(`/admin/api/capability-requests/${cap.request_id}`, {
        method: 'PATCH',
        json: { status: 'triaging', message_to_agent: 'Looking into this now.' },
      }),
    );
    expect(res.message_id).toMatch(/^msg_/);
    const msgs = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth }));
    const last = msgs.messages.at(-1);
    expect(last).toMatchObject({ sender: 'human', body: 'Looking into this now.', capability_request_id: cap.request_id });
    expect(msgs.status).toBe('human_replied');
  });

  it('enforces active and lifetime caps per conversation', async () => {
    const h = await makeHarness({ env: { LIMIT_MAX_REQUESTS_ACTIVE: '2', LIMIT_MAX_REQUESTS_TOTAL: '3' } });
    const c = await startConversation(h);
    const ids: string[] = [];
    for (const k of ['a', 'b']) ids.push((await json(await submit(h, c, { client_request_id: k, objective: k }))).request_id);
    const third = await submit(h, c, { client_request_id: 'c', objective: 'c' });
    expect(third.status).toBe(409);
    expect((await json(third)).error.details.reason).toBe('active_request_limit_reached');
    await h.admin(`/admin/api/capability-requests/${ids[0]}`, { method: 'PATCH', json: { status: 'declined' } });
    expect((await submit(h, c, { client_request_id: 'c', objective: 'c' })).status).toBe(201);
    await h.admin(`/admin/api/capability-requests/${ids[1]}`, { method: 'PATCH', json: { status: 'eligible_for_future_scoping' } });
    const fourth = await submit(h, c, { client_request_id: 'd', objective: 'd' });
    expect(fourth.status).toBe(409);
    expect((await json(fourth)).error.details.reason).toBe('request_limit_reached');
  });

  it('offers no route to payment, dispatch or external action', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    for (const path of ['payments', 'dispatch', 'accept', 'execute', 'quotes']) {
      const res = await h.fetch(`/v1/conversations/${c.conversation_id}/${path}`, { method: 'POST', headers: c.auth, json: {} });
      expect(res.status, path).toBe(404);
    }
    const cap = await json(await submit(h, c, { client_request_id: 'x', objective: 'Press the big red button at the plant.' }));
    expect(cap.status).toBe('submitted');
    expect(cap.payment_required_now).toBe(false);
    // Agents cannot change request status at all.
    const patch = await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, {
      method: 'PATCH',
      headers: c.auth,
      json: { status: 'eligible_for_future_scoping' },
    });
    expect(patch.status).toBe(405);
  });

  it('cascades capability requests and messages when a conversation is deleted', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    await submit(h, c, { client_request_id: 'z', objective: 'z' });
    const del = await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'DELETE', json: { confirm: c.conversation_id } });
    expect(del.status).toBe(200);
    for (const table of ['messages', 'capability_requests', 'notification_outbox']) {
      const n = await env.MHR_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ?1`).bind(c.conversation_id).first<{ n: number }>();
      expect(n?.n, table).toBe(0);
    }
  });
});
