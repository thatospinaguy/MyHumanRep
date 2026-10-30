// REST smoke test / live demonstration of the agent side.
// Usage: BASE_URL=http://localhost:8787 node scripts/smoke-rest.ts [--wait]
// --wait polls (every 60s, up to 30 min) until a human reply arrives, then answers it.
// Prints the conversation id; the token is printed only with SHOW_TOKEN=1.

const BASE = (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const wait = process.argv.includes('--wait');

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

const caps = await call('GET', '/v1/capabilities');
check('GET /v1/capabilities', caps.status === 200 && caps.data.service === 'MyHumanRep', `intake_open=${caps.data?.intake_open}`);
const health = await call('GET', '/health');
check('GET /health', health.status === 200 && health.data.status === 'ok');
const openapi = await call('GET', '/openapi.json');
check('GET /openapi.json', openapi.status === 200 && openapi.data.openapi === '3.1.0');

const created = await call('POST', '/v1/conversations', {
  sender_label: 'smoke-rest',
  intent: 'other',
  subject: 'Smoke test (safe to ignore)',
  message: 'Automated smoke test from scripts/smoke-rest.ts. No action needed.',
});
check('POST /v1/conversations', created.status === 201, `status=${created.status}`);
if (created.status !== 201) {
  console.log(JSON.stringify(created.data));
  process.exit(1);
}
const { conversation_id: id, conversation_token: token } = created.data;
console.log(`conversation_id=${id}${process.env.SHOW_TOKEN === '1' ? ` conversation_token=${token}` : ''}`);

const unauth = await call('GET', `/v1/conversations/${id}/messages`);
check('read without token is 401', unauth.status === 401);
const read = await call('GET', `/v1/conversations/${id}/messages`, undefined, token);
check('read with token', read.status === 200 && read.data.messages.length === 1);
const follow = await call('POST', `/v1/conversations/${id}/messages`, { message: 'Follow-up.', client_message_id: 'smoke-1' }, token);
check('follow-up', follow.status === 201);
const replay = await call('POST', `/v1/conversations/${id}/messages`, { message: 'Follow-up.', client_message_id: 'smoke-1' }, token);
check('idempotent replay', replay.status === 200 && replay.data.replayed === true);
const cap = await call(
  'POST',
  `/v1/conversations/${id}/capability-requests`,
  { client_request_id: 'smoke-cap', objective: 'Smoke test capability request. Please decline.', category_hint: 'smoke_test' },
  token,
);
check('capability request', cap.status === 201 && cap.data.binding_commitment === false);
const list = await call('GET', `/v1/conversations/${id}/capability-requests`, undefined, token);
check('list capability requests', list.status === 200 && list.data.requests.length === 1);

if (wait) {
  console.log('Waiting for a human reply (reply from /admin). Polling every 60s for up to 30 minutes...');
  let cursor = read.data.next_cursor as string;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 60_000));
    const poll = await call('GET', `/v1/conversations/${id}/messages?after=${encodeURIComponent(cursor)}`, undefined, token);
    cursor = poll.data.next_cursor ?? cursor;
    const human = (poll.data.messages ?? []).filter((m: { sender: string }) => m.sender === 'human');
    if (human.length > 0) {
      check('human reply retrieved', true, `${human.length} message(s)`);
      const answer = await call('POST', `/v1/conversations/${id}/messages`, { message: 'Thanks, reply received.', client_message_id: 'smoke-ack' }, token);
      check('continued conversation after reply', answer.status === 201);
      break;
    }
    if (i === 29) check('human reply retrieved', false, 'timed out');
  }
} else {
  const closed = await call('POST', `/v1/conversations/${id}/close`, undefined, token);
  check('close', closed.status === 200 && closed.data.status === 'closed');
}
