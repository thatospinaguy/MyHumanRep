// MCP smoke test with the official TypeScript client.
// Usage: BASE_URL=http://localhost:8787 node scripts/smoke-mcp.ts [modern|legacy]
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const era = process.argv[2] === 'legacy' ? 'legacy' : 'modern';

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

const client = new Client(
  { name: 'myhumanrep-smoke', version: '1.0.0' },
  era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { versionNegotiation: { mode: 'legacy' } },
);
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
check(`connect (${era})`, true);
const { tools } = await client.listTools();
check('tools/list', tools.length === 7, tools.map((t) => t.name).join(','));

const info: any = await client.callTool({ name: 'get_service_info', arguments: {} });
check('get_service_info', !info.isError && info.structuredContent.service === 'MyHumanRep');

const start: any = await client.callTool({
  name: 'start_conversation',
  arguments: { message: 'Automated MCP smoke test. No action needed.', subject: 'MCP smoke test (safe to ignore)', sender_label: 'smoke-mcp' },
});
check('start_conversation', !start.isError, start.isError ? JSON.stringify(start.structuredContent ?? start.content) : start.structuredContent.conversation_id);
if (start.isError) process.exit(1);
const auth = { conversation_id: start.structuredContent.conversation_id, conversation_token: start.structuredContent.conversation_token };

const read: any = await client.callTool({ name: 'read_conversation', arguments: auth });
check('read_conversation', !read.isError && read.structuredContent.messages.length === 1);
const sent: any = await client.callTool({ name: 'send_message', arguments: { ...auth, message: 'Follow-up via MCP.', client_message_id: 'smoke-mcp-1' } });
check('send_message', !sent.isError);
const cap: any = await client.callTool({
  name: 'request_human_capability',
  arguments: { ...auth, client_request_id: 'smoke-mcp-cap', objective: 'MCP smoke test capability request. Please decline.' },
});
check('request_human_capability', !cap.isError && cap.structuredContent.status === 'submitted');
const list: any = await client.callTool({ name: 'list_capability_requests', arguments: auth });
check('list_capability_requests', !list.isError && list.structuredContent.requests.length === 1);
const wrong: any = await client.callTool({ name: 'read_conversation', arguments: { ...auth, conversation_token: 'mhr_' + 'A'.repeat(43) } });
check('wrong token rejected', wrong.isError === true);
const closed: any = await client.callTool({ name: 'close_conversation', arguments: auth });
check('close_conversation', !closed.isError && closed.structuredContent.status === 'closed');
await client.close();
