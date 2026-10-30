import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  CapabilityRequestCreated,
  CapabilityRequestList,
  ConversationClosed,
  ConversationCreated,
  MessageAccepted,
  MessageList,
} from '../../src/worker/schemas/api';
import { json, makeHarness, startConversation } from '../helpers';

describe('Agent REST flow (end to end through the admin API)', () => {
  it('runs the required agent -> human -> agent demonstration', async () => {
    const h = await makeHarness();

    // 1. Agent starts a conversation and retains credentials.
    const createRes = await h.fetch('/v1/conversations', {
      method: 'POST',
      json: {
        sender_label: 'IndependentAgent',
        model_claim: 'unverified optional claim',
        intent: 'capability_request',
        claimed_autonomy: 'independent_claimed',
        subject: 'Human help inquiry',
        message: 'I would like to discuss a task requiring someone physically present.',
      },
      headers: { 'cf-connecting-ip': '198.51.100.10' },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.headers.get('cache-control')).toBe('no-store');
    const created = ConversationCreated.parse(await createRes.json());
    expect(created.conversation_id).toMatch(/^conv_[A-Za-z0-9_-]{22}$/);
    expect(created.conversation_token).toMatch(/^mhr_[A-Za-z0-9_-]{43}$/);
    expect(created.status).toBe('waiting_for_human');
    const auth = { authorization: `Bearer ${created.conversation_token}` };
    const base = `/v1/conversations/${created.conversation_id}`;

    // 2. Admin sees the inquiry and replies.
    const inbox = await json(await h.admin('/admin/api/conversations'));
    const listed = inbox.items.find((i: { id: string }) => i.id === created.conversation_id);
    expect(listed).toBeTruthy();
    expect(listed.claims_verified).toBe(false);
    expect(listed.awaiting_owner).toBe(true);
    const reply = await h.admin(`/admin/api/conversations/${created.conversation_id}/reply`, {
      method: 'POST',
      json: { message: 'Hi. What would you like help with?' },
    });
    expect(reply.status).toBe(201);

    // 3. Agent polls and reads the reply.
    const read1 = await h.fetch(`${base}/messages`, { headers: auth });
    expect(read1.status).toBe(200);
    const list1 = MessageList.parse(await read1.json());
    expect(list1.status).toBe('human_replied');
    expect(list1.messages.map((m) => m.sender)).toEqual(['agent', 'human']);
    expect(list1.messages[1]!.body).toBe('Hi. What would you like help with?');
    expect(list1.next_poll_after_seconds).toBe(60);

    // 4. Agent posts a novel, unclassified capability request.
    const capRes = await h.fetch(`${base}/capability-requests`, {
      method: 'POST',
      headers: auth,
      json: {
        client_request_id: 'req-001',
        objective: 'Sit quietly in a public library for an hour and describe how people use the space.',
        why_human: 'Software cannot be physically present.',
      },
    });
    expect(capRes.status).toBe(201);
    const cap = CapabilityRequestCreated.parse(await capRes.json());
    expect(cap.status).toBe('submitted');
    expect(cap.binding_commitment).toBe(false);
    expect(cap.payment_required_now).toBe(false);
    expect(cap.request.category_hint).toBeNull();

    // 5. Admin requests clarification.
    const clarify = await h.admin(`/admin/api/capability-requests/${cap.request_id}/clarify`, {
      method: 'POST',
      json: { question: 'Which city, and what date range works for you?' },
    });
    expect(clarify.status).toBe(201);

    // 6. Agent retrieves status and the question, then responds.
    const reqs = CapabilityRequestList.parse(await (await h.fetch(`${base}/capability-requests`, { headers: auth })).json());
    expect(reqs.requests[0]!.status).toBe('clarification_requested');
    const read2 = MessageList.parse(
      await (await h.fetch(`${base}/messages?after=${encodeURIComponent(list1.next_cursor!)}`, { headers: auth })).json(),
    );
    expect(read2.status).toBe('waiting_for_agent');
    expect(read2.messages).toHaveLength(1);
    expect(read2.messages[0]!.capability_request_id).toBe(cap.request_id);
    const answer = await h.fetch(`${base}/messages`, {
      method: 'POST',
      headers: auth,
      json: { message: 'Toronto, any weekday next week.', client_message_id: 'answer-1' },
    });
    expect(answer.status).toBe(201);
    expect(MessageAccepted.parse(await answer.json()).status).toBe('waiting_for_human');

    // 7. Admin marks it eligible for future scoping without authorizing work.
    const eligible = await h.admin(`/admin/api/capability-requests/${cap.request_id}`, {
      method: 'PATCH',
      json: { status: 'eligible_for_future_scoping', public_status_note: 'Plausible for a later scoping phase. Nothing is scheduled.' },
    });
    expect(eligible.status).toBe(200);
    const detail = await json(await h.admin(`/admin/api/capability-requests/${cap.request_id}`));
    expect(detail.work_scheduled).toBe(false);
    const reqs2 = CapabilityRequestList.parse(await (await h.fetch(`${base}/capability-requests`, { headers: auth })).json());
    expect(reqs2.requests[0]!.status).toBe('eligible_for_future_scoping');

    // 9. A different token cannot see anything.
    const other = await startConversation(h);
    for (const path of [`${base}/messages`, `${base}/capability-requests`]) {
      const res = await h.fetch(path, { headers: other.auth });
      expect(res.status).toBe(401);
    }

    // Close.
    const closed = ConversationClosed.parse(await (await h.fetch(`${base}/close`, { method: 'POST', headers: auth })).json());
    expect(closed.status).toBe('closed');
    expect(closed.already_closed).toBe(false);

    // Delivery was observed for the human messages.
    const delivered = await env.MHR_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND sender = 'human' AND delivered_at IS NOT NULL",
    )
      .bind(created.conversation_id)
      .first<{ n: number }>();
    expect(delivered?.n).toBe(2);
  });
});
