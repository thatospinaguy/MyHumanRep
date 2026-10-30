import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { json, makeHarness, startConversation, type Harness } from '../helpers';

type Era = 'modern' | 'legacy';

async function connect(h: Harness, era: Era, headers: Record<string, string> = {}) {
  const client = new Client(
    { name: 'mhr-test-client', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { versionNegotiation: { mode: 'legacy' } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${h.envOverrides.PUBLIC_BASE_URL}/mcp`), {
    fetch: async (url, init) => {
      const u = new URL(url.toString());
      const merged = new Headers(init?.headers);
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

const TOOLS = [
  'close_conversation',
  'get_service_info',
  'list_capability_requests',
  'read_conversation',
  'request_human_capability',
  'send_message',
  'start_conversation',
];

describe.each<Era>(['modern', 'legacy'])('MCP over Streamable HTTP (%s era)', (era) => {
  it('negotiates, lists tools and runs the full agent -> human -> agent flow', async () => {
    const h = await makeHarness();
    const client = await connect(h, era, { 'cf-connecting-ip': `198.51.100.${era === 'modern' ? 1 : 2}` });

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const start = tools.tools.find((t) => t.name === 'start_conversation')!;
    expect(start.inputSchema.required).toEqual(['message']);

    const info = structured(await client.callTool({ name: 'get_service_info', arguments: {} }));
    expect(info.mcp_url).toBe('https://myhumanrep.test/mcp');
    expect(info.claimed_agent_identity_verified).toBe(false);
    expect(info.automatic_task_execution).toBe(false);

    const startRes = await client.callTool({
      name: 'start_conversation',
      arguments: { message: 'Hello from an MCP client.', claimed_autonomy: 'delegated_autonomous', subject: 'MCP hello' },
    });
    expect(startRes.isError).toBeFalsy();
    const conv = structured(startRes);
    expect(conv.conversation_token).toMatch(/^mhr_/);
    const auth = { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token };

    // Same backend: the conversation is visible to the owner with interface=mcp.
    const detail = await json(await h.admin(`/admin/api/conversations/${conv.conversation_id}`));
    expect(detail.conversation.created_via).toBe('mcp');
    await h.admin(`/admin/api/conversations/${conv.conversation_id}/reply`, {
      method: 'POST',
      json: { message: 'Hello from the human side.' },
    });

    const read = structured(await client.callTool({ name: 'read_conversation', arguments: auth }));
    expect(read.status).toBe('human_replied');
    expect(read.messages.map((m: { sender: string }) => m.sender)).toEqual(['agent', 'human']);

    const sent = structured(
      await client.callTool({ name: 'send_message', arguments: { ...auth, message: 'Thanks.', client_message_id: 'm-1' } }),
    );
    expect(sent.replayed).toBe(false);
    const replay = structured(
      await client.callTool({ name: 'send_message', arguments: { ...auth, message: 'Thanks.', client_message_id: 'm-1' } }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.message.id).toBe(sent.message.id);

    const cap = structured(
      await client.callTool({
        name: 'request_human_capability',
        arguments: { ...auth, client_request_id: 'r-1', objective: 'Taste-test a new recipe and describe it honestly.', budget_amount: 25.5, budget_currency: 'USD' },
      }),
    );
    expect(cap.status).toBe('submitted');
    expect(cap.request.budget).toEqual({ amount: 25.5, amount_minor: 2550, currency: 'USD', indicative_only: true });

    await h.admin(`/admin/api/capability-requests/${cap.request_id}/clarify`, {
      method: 'POST',
      json: { question: 'Any dietary restrictions to respect?' },
    });
    const list = structured(await client.callTool({ name: 'list_capability_requests', arguments: auth }));
    expect(list.requests[0].status).toBe('clarification_requested');
    expect(list.requests[0]).not.toHaveProperty('internal_notes');

    const closed = structured(await client.callTool({ name: 'close_conversation', arguments: auth }));
    expect(closed.status).toBe('closed');
    const afterClose = await client.callTool({
      name: 'send_message',
      arguments: { ...auth, message: 'One more.', client_message_id: 'm-2' },
    });
    expect(afterClose.isError).toBe(true);
    expect(structured(afterClose).error.details.reason).toBe('conversation_closed');

    await client.close();
  });

  it('applies the same authorization rules as REST', async () => {
    const h = await makeHarness();
    const a = await startConversation(h);
    const b = await startConversation(h);
    const client = await connect(h, era);

    const wrong = await client.callTool({
      name: 'read_conversation',
      arguments: { conversation_id: a.conversation_id, conversation_token: b.conversation_token },
    });
    expect(wrong.isError).toBe(true);
    expect(structured(wrong).error.code).toBe('unauthorized');
    expect(structured(wrong).http_status).toBe(401);

    const garbage = await client.callTool({
      name: 'list_capability_requests',
      arguments: { conversation_id: 'conv_doesnotexist', conversation_token: 'nope' },
    });
    expect(garbage.isError).toBe(true);
    expect(structured(garbage).error.code).toBe('unauthorized');

    // Validation is shared: blank message rejected.
    const blank = await client.callTool({ name: 'start_conversation', arguments: { message: '   ' } });
    expect(blank.isError).toBe(true);
    await client.close();
  });
});

describe('MCP transport safety', () => {
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  };

  it('rejects a disallowed Origin', async () => {
    const h = await makeHarness();
    const res = await h.fetch('/mcp', {
      method: 'POST',
      json: initBody,
      headers: { origin: 'https://evil.example', accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts the canonical Origin', async () => {
    const h = await makeHarness();
    const res = await h.fetch('/mcp', {
      method: 'POST',
      json: initBody,
      headers: { origin: 'https://myhumanrep.test', accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects GET, wrong content type, oversize and malformed JSON-RPC', async () => {
    const h = await makeHarness();
    expect((await h.fetch('/mcp')).status).toBe(405);
    expect((await h.fetch('/mcp', { method: 'DELETE' })).status).toBe(405);
    expect(
      (await h.fetch('/mcp', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status,
    ).toBe(415);
    const big = 'a'.repeat(70 * 1024);
    expect(
      (await h.fetch('/mcp', { method: 'POST', body: big, headers: { 'content-type': 'application/json', 'content-length': String(big.length) } }))
        .status,
    ).toBe(413);
    const malformed = await h.fetch('/mcp', {
      method: 'POST',
      body: '{"jsonrpc": "2.0", "id": 1, "method": ',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    const notRpc = await h.fetch('/mcp', {
      method: 'POST',
      json: { hello: 'world' },
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(notRpc.status).toBeGreaterThanOrEqual(400);
    expect(notRpc.status).toBeLessThan(500);
  });

  it('answers an unsupported modern protocol version with an error naming supported versions', async () => {
    const h = await makeHarness();
    const res = await h.fetch('/mcp', {
      method: 'POST',
      json: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2099-01-01',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
          },
        },
      },
      headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2099-01-01' },
    });
    const body = await res.json<{ error?: { code: number; message: string; data?: unknown } }>();
    expect(body.error).toBeTruthy();
    expect(JSON.stringify(body.error)).toContain('2026-07-28');
    expect(JSON.stringify(body)).not.toContain('"tools"');
  });

  it('negotiates a legacy initialize with an unknown version down to a supported one', async () => {
    const h = await makeHarness();
    const res = await h.fetch('/mcp', {
      method: 'POST',
      json: { ...initBody, params: { ...initBody.params, protocolVersion: '1999-01-01' } },
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
    expect(payload.result.protocolVersion).toMatch(/^20\d\d-\d\d-\d\d$/);
    expect(payload.result.protocolVersion).not.toBe('1999-01-01');
  });

  it('rate limits MCP per source with 429 and Retry-After', async () => {
    const h = await makeHarness({ env: { LIMIT_MCP_PER_SOURCE_PER_MINUTE: '2' } });
    const headers = { accept: 'application/json, text/event-stream', 'cf-connecting-ip': '192.0.2.77' };
    expect((await h.fetch('/mcp', { method: 'POST', json: initBody, headers })).status).toBe(200);
    expect((await h.fetch('/mcp', { method: 'POST', json: initBody, headers })).status).toBe(200);
    const limited = await h.fetch('/mcp', { method: 'POST', json: initBody, headers });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
