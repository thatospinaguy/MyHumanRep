import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';

const MCP_URL = new URL('http://localhost:8788/mcp');

for (const era of ['modern', 'legacy'] as const) {
  test(`official MCP client (${era}) completes the flow against wrangler dev over real HTTP`, async ({ request }) => {
    const client = new Client(
      { name: 'mhr-e2e', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { versionNegotiation: { mode: 'legacy' } },
    );
    await client.connect(new StreamableHTTPClientTransport(MCP_URL));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['start_conversation', 'read_messages', 'discover_human_capabilities', 'describe_human_need', 'request_human_dialogue']),
    );

    const start = (await client.callTool({ name: 'start_conversation', arguments: { message: `Hello over ${era} MCP` } })) as {
      structuredContent: { conversation_id: string; conversation_token: string };
    };
    const auth = { conversation_id: start.structuredContent.conversation_id, conversation_token: start.structuredContent.conversation_token };

    // Owner replies through the admin API (dev auth on localhost).
    const reply = await request.post(`/admin/api/conversations/${auth.conversation_id}/reply`, {
      headers: { 'x-mhr-admin': '1' },
      data: { message: `Human reply for ${era}` },
    });
    expect(reply.status()).toBe(201);

    const read = (await client.callTool({ name: 'read_conversation', arguments: auth })) as {
      structuredContent: { messages: Array<{ sender: string; body: string }> };
    };
    expect(read.structuredContent.messages.at(-1)).toMatchObject({ sender: 'human', body: `Human reply for ${era}` });

    const cap = (await client.callTool({
      name: 'request_human_capability',
      arguments: { ...auth, client_request_id: 'mcp-e2e', objective: 'Describe the smell of a specific bakery at opening time.' },
    })) as { isError?: boolean; structuredContent: { status: string } };
    expect(cap.isError).toBeFalsy();
    expect(cap.structuredContent.status).toBe('submitted');

    const follow = (await client.callTool({
      name: 'send_message',
      arguments: { ...auth, message: 'Continuing the same conversation.', client_message_id: 'mcp-e2e-1' },
    })) as { isError?: boolean };
    expect(follow.isError).toBeFalsy();

    // REST sees the same conversation (shared backend).
    const rest = await request.get(`/v1/conversations/${auth.conversation_id}/messages`, {
      headers: { authorization: `Bearer ${auth.conversation_token}` },
    });
    expect((await rest.json()).messages).toHaveLength(3);
    await client.close();
  });
}
