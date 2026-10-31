// Agent continuity without credentials in tool arguments: account header on /mcp, account-owned
// threads over REST, wait_for_reply, token rotation over MCP, lost-token continuation claims
// (T-012, T-013, T-017, T-020, T-024, T-038, T-039, T-059, T-060; spec 13.4, 14.5).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { freshIp, json, makeHarness, startConversation, type Harness } from '../helpers';

async function connect(h: Harness, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'mhr-continuity-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StreamableHTTPClientTransport(new URL(`${h.envOverrides.PUBLIC_BASE_URL}/mcp`), {
    fetch: async (url, init) => {
      const u = new URL(url.toString());
      const merged = new Headers(init?.headers);
      merged.set('cf-connecting-ip', headers['cf-connecting-ip'] ?? freshIp());
      for (const [k, v] of Object.entries(headers)) merged.set(k, v);
      return h.fetch(u.pathname + u.search, { ...init, headers: merged } as RequestInit);
    },
  });
  await client.connect(transport);
  return client;
}

function structured<T = any>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

async function account(h: Harness) {
  const res = await h.fetch('/v1/agent-accounts', {
    method: 'POST',
    json: { display_label: 'continuity', terms_accepted: true },
    headers: { 'cf-connecting-ip': freshIp() },
  });
  if (res.status !== 201) throw new Error(`account ${res.status} ${await res.text()}`);
  const body = await json(res);
  return { ...body, header: { authorization: `Bearer ${body.account_token}` } } as {
    account_id: string;
    account_token: string;
    header: Record<string, string>;
  };
}

async function humanReply(h: Harness, conversationId: string, message: string) {
  const res = await h.admin(`/admin/api/conversations/${conversationId}/reply`, { method: 'POST', json: { message } });
  expect(res.status).toBeLessThan(300);
}

describe('MCP account header (T-017, T-059)', () => {
  it('links new threads to the header account, withholds the thread token and survives a restart', async () => {
    const h = await makeHarness();
    const acct = await account(h);
    const client = await connect(h, acct.header);

    const started = structured(await client.callTool({ name: 'start_conversation', arguments: { message: 'Hello via header.', subject: 'Header' } }));
    expect(started.conversation_token).toBeNull();
    expect(started.credential).toBe('account_header');
    expect(started.linked_account_id).toBe(acct.account_id);
    const id = started.conversation_id as string;

    // No token argument anywhere.
    const sent = await client.callTool({ name: 'send_message', arguments: { conversation_id: id, message: 'Follow-up.', client_message_id: 'h-1' } });
    expect(sent.isError).toBeFalsy();
    await humanReply(h, id, 'Hello from the human side.');
    await client.close();

    // "Restart": a new connection that remembers nothing but has the same configured header.
    const restarted = await connect(h, acct.header);
    const mine = structured(await restarted.callTool({ name: 'list_my_conversations', arguments: {} }));
    expect(mine.conversations).toHaveLength(1);
    expect(mine.conversations[0]).toMatchObject({ conversation_id: id, subject: 'Header', status: 'human_replied', unread_replies: 1 });

    const read = structured(await restarted.callTool({ name: 'read_conversation', arguments: { conversation_id: id } }));
    expect(read.messages.map((m: { sender: string }) => m.sender)).toEqual(['agent', 'agent', 'human']);
    const status = structured(await restarted.callTool({ name: 'get_conversation_status', arguments: { conversation_id: id } }));
    expect(status).toMatchObject({ conversation_id: id, status: 'human_replied' });
    await restarted.close();
  });

  it('T-012/T-024: the header account cannot reach threads it does not own, and unknown IDs fail the same way', async () => {
    const h = await makeHarness();
    const owner = await account(h);
    const other = await account(h);
    const ownerClient = await connect(h, owner.header);
    const id = structured(await ownerClient.callTool({ name: 'start_conversation', arguments: { message: 'Mine.' } })).conversation_id;
    await ownerClient.close();

    const otherClient = await connect(h, other.header);
    const foreign = await otherClient.callTool({ name: 'read_conversation', arguments: { conversation_id: id } });
    const unknown = await otherClient.callTool({ name: 'read_conversation', arguments: { conversation_id: 'conv_AAAAAAAAAAAAAAAAAAAAAA' } });
    for (const r of [foreign, unknown]) {
      expect(r.isError).toBe(true);
      expect(structured(r).http_status).toBe(401);
      expect(structured(r).error.details.reason).toBe('invalid_account_credential');
    }
    expect(JSON.stringify(structured(foreign))).not.toContain('Mine.');
    // An unclaimed token-only thread is not reachable through the header either (T-038).
    const tokenThread = await startConversation(h);
    const unclaimed = await otherClient.callTool({ name: 'read_conversation', arguments: { conversation_id: tokenThread.conversation_id } });
    expect(unclaimed.isError).toBe(true);
    await otherClient.close();
  });

  it('T-060: without a header or token argument, conversation tools are denied', async () => {
    const h = await makeHarness();
    const conv = await startConversation(h);
    const client = await connect(h);
    const res = await client.callTool({ name: 'read_conversation', arguments: { conversation_id: conv.conversation_id } });
    expect(res.isError).toBe(true);
    expect(structured(res).error.code).toBe('unauthorized');
    expect(JSON.stringify(structured(res))).not.toContain('talk to a human');
    await client.close();
  });

  it('T-007: a non-account Authorization header is ignored, so existing token clients keep working', async () => {
    const h = await makeHarness();
    const client = await connect(h, { authorization: 'Bearer some-gateway-credential' });
    const started = structured(await client.callTool({ name: 'start_conversation', arguments: { message: 'Old-style client.' } }));
    expect(started.conversation_token).toMatch(/^mhr_/);
    const read = await client.callTool({
      name: 'read_conversation',
      arguments: { conversation_id: started.conversation_id, conversation_token: started.conversation_token },
    });
    expect(read.isError).toBeFalsy();
    await client.close();
  });

  it('an explicit conversation_token argument still wins over the header', async () => {
    const h = await makeHarness();
    const acct = await account(h);
    const conv = await startConversation(h);
    const client = await connect(h, acct.header);
    const read = await client.callTool({
      name: 'read_conversation',
      arguments: { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token },
    });
    expect(read.isError).toBeFalsy();
    // T-039: claiming still needs the thread token as proof; afterwards the header alone works.
    const claim = await client.callTool({ name: 'claim_conversation', arguments: { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token } });
    expect(claim.isError).toBeFalsy();
    const viaHeader = await client.callTool({ name: 'read_conversation', arguments: { conversation_id: conv.conversation_id } });
    expect(viaHeader.isError).toBeFalsy();
    await client.close();
  });

  it('T-013: an invalid account header fails per tool call, not at the transport', async () => {
    const h = await makeHarness();
    const client = await connect(h, { authorization: `Bearer mhra_${'x'.repeat(43)}` });
    const info = await client.callTool({ name: 'get_service_info', arguments: {} });
    expect(info.isError).toBeFalsy();
    const start = await client.callTool({ name: 'start_conversation', arguments: { message: 'Hi.' } });
    expect(start.isError).toBe(true);
    expect(structured(start).error.details.reason).toBe('invalid_account_credential');
    await client.close();
  });
});

describe('REST with an account token', () => {
  it('links on create and authorizes thread routes for owned conversations only', async () => {
    const h = await makeHarness();
    const acct = await account(h);
    const res = await h.fetch('/v1/conversations', {
      method: 'POST',
      json: { message: 'REST with account.' },
      headers: { ...acct.header, 'cf-connecting-ip': freshIp() },
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    // REST keeps the V1 contract: the thread token is still returned.
    expect(created.conversation_token).toMatch(/^mhr_/);
    expect(created.linked_account_id).toBe(acct.account_id);

    const read = await h.fetch(`/v1/conversations/${created.conversation_id}/messages`, { headers: acct.header });
    expect(read.status).toBe(200);
    const list = await json(await h.fetch('/v1/agent-accounts/me/conversations', { headers: acct.header }));
    expect(list.conversations.map((c: { conversation_id: string }) => c.conversation_id)).toEqual([created.conversation_id]);

    const stranger = await startConversation(h);
    expect((await h.fetch(`/v1/conversations/${stranger.conversation_id}/messages`, { headers: acct.header })).status).toBe(401);
  });
});

describe('wait_for_reply', () => {
  it('returns at once when an undelivered reply exists, then times out when there is nothing new', async () => {
    const h = await makeHarness();
    const conv = await startConversation(h);
    await humanReply(h, conv.conversation_id, 'Already here.');
    const client = await connect(h);
    const auth = { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token };

    const first = structured(await client.callTool({ name: 'wait_for_reply', arguments: { ...auth, timeout_seconds: 5 } }));
    expect(first.timed_out).toBe(false);
    expect(first.messages.map((m: { body: string }) => m.body)).toEqual(['Already here.']);

    const started = Date.now();
    const second = structured(await client.callTool({ name: 'wait_for_reply', arguments: { ...auth, timeout_seconds: 1 } }));
    expect(second.timed_out).toBe(true);
    expect(second.messages).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);

    const third = structured(await client.callTool({ name: 'wait_for_reply', arguments: { ...auth, after: first.next_cursor, timeout_seconds: 0 } }));
    expect(third.timed_out).toBe(true);
    await client.close();
  });

  it('returns a reply that arrives while waiting (REST long poll)', async () => {
    const h = await makeHarness();
    const conv = await startConversation(h);
    const waiting = h.fetch(`/v1/conversations/${conv.conversation_id}/messages/wait?timeout_seconds=10`, { headers: conv.auth });
    await new Promise((r) => setTimeout(r, 300));
    await humanReply(h, conv.conversation_id, 'Arrived mid-wait.');
    const res = await waiting;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await json(res);
    expect(body.timed_out).toBe(false);
    expect(body.messages.map((m: { body: string }) => m.body)).toEqual(['Arrived mid-wait.']);
  });

  it('rejects out-of-range timeouts and unauthenticated waits', async () => {
    const h = await makeHarness();
    const conv = await startConversation(h);
    expect((await h.fetch(`/v1/conversations/${conv.conversation_id}/messages/wait?timeout_seconds=26`, { headers: conv.auth })).status).toBe(400);
    expect((await h.fetch(`/v1/conversations/${conv.conversation_id}/messages/wait?timeout_seconds=0`)).status).toBe(401);
    expect((await h.fetch(`/v1/conversations/${conv.conversation_id}/messages/wait`, { method: 'POST', headers: conv.auth })).status).toBe(405);
  });
});

describe('T-020: rotate_conversation_token over MCP', () => {
  it('revokes the old token and the new one works', async () => {
    const h = await makeHarness();
    const conv = await startConversation(h);
    const client = await connect(h);
    const rotated = structured(
      await client.callTool({ name: 'rotate_conversation_token', arguments: { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token } }),
    );
    expect(rotated.previous_token_revoked).toBe(true);
    expect(rotated.conversation_token).not.toBe(conv.conversation_token);
    const old = await client.callTool({ name: 'read_conversation', arguments: { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token } });
    expect(old.isError).toBe(true);
    const fresh = await client.callTool({ name: 'read_conversation', arguments: { conversation_id: conv.conversation_id, conversation_token: rotated.conversation_token } });
    expect(fresh.isError).toBeFalsy();
    await client.close();
  });
});

describe('Lost-token continuation (spec 13.4)', () => {
  it('records an unverified link the owner sees, and grants the new thread nothing', async () => {
    const h = await makeHarness();
    const lost = await startConversation(h, { message: 'Secret original thread.', subject: 'Original' });
    const next = await startConversation(h, { message: 'I lost my token.', previous_conversation_id: lost.conversation_id });

    // The new token cannot read the old thread.
    expect((await h.fetch(`/v1/conversations/${lost.conversation_id}/messages`, { headers: next.auth })).status).toBe(401);

    const nextDetail = await json(await h.admin(`/admin/api/conversations/${next.conversation_id}`));
    expect(nextDetail.continuity.continues).toEqual([
      expect.objectContaining({ conversation_id: lost.conversation_id, exists: true, subject: 'Original' }),
    ]);
    expect(nextDetail.continuity.evidence_status).toBe('self_reported_unverified');
    const claim = nextDetail.self_reports.find((r: { claim_value: string }) => r.claim_value === 'continues_conversation');
    expect(claim.evidence_status).toBe('self_reported_unverified');

    const lostDetail = await json(await h.admin(`/admin/api/conversations/${lost.conversation_id}`));
    expect(lostDetail.continuity.continued_by.map((c: { conversation_id: string }) => c.conversation_id)).toEqual([next.conversation_id]);
  });

  it('T-024: a nonexistent previous_conversation_id is accepted silently (no existence oracle); malformed is rejected', async () => {
    const h = await makeHarness();
    const ghost = 'conv_BBBBBBBBBBBBBBBBBBBBBB';
    const next = await startConversation(h, { previous_conversation_id: ghost });
    const detail = await json(await h.admin(`/admin/api/conversations/${next.conversation_id}`));
    expect(detail.continuity.continues).toEqual([expect.objectContaining({ conversation_id: ghost, exists: false })]);

    const bad = await h.fetch('/v1/conversations', {
      method: 'POST',
      json: { message: 'x', previous_conversation_id: 'not-an-id' },
      headers: { 'cf-connecting-ip': freshIp() },
    });
    expect(bad.status).toBe(400);
  });
});
