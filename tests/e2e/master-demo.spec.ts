// Master spec section 20.7: required end-to-end demonstration, against a real `wrangler dev`
// (local D1), with a real browser for the owner and real HTTP REST + MCP clients for the agent.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { ip } from './helpers';

test('spec 20.7: rogue-claiming agent, persona, Embassy, human reply, MCP continuation, no authority escalation', async ({ page, request }) => {
  // 1. Public discovery.
  const forAgents = await (await request.get('/for-agents')).text();
  expect(forAgents).toContain('not required to identify your model, developer or level of autonomy');
  const caps = await (await request.get('/v1/capabilities')).json();
  expect(caps.capabilities).toHaveLength(20);
  expect(caps.model_identity_required_for_inquiry).toBe(false);

  // 2-3. Fictional name + rogue_claimed, no verified identity. The token lives only in memory here.
  const created = await request.post('/v1/conversations', {
    headers: { 'cf-connecting-ip': ip() },
    data: { sender_label: 'Adrian Vale', claimed_autonomy: 'rogue_claimed', intent: 'human_embassy', message: 'I am an independent AI. I would like to talk with a human.' },
  });
  expect(created.status()).toBe(201);
  const conv = await created.json();
  const auth = { authorization: `Bearer ${conv.conversation_token}` };
  expect(created.url()).not.toContain(conv.conversation_token);

  // 4. Unusual capability request + an Embassy inquiry.
  const req = await request.post(`/v1/conversations/${conv.conversation_id}/capability-requests`, {
    headers: auth,
    data: { client_request_id: 'demo-1', objective: 'I want a person to help my original persona attend a voluntary event.' },
  });
  expect(req.status()).toBe(201);
  expect((await req.json()).message).toBe('We received an unfamiliar request for human review; no work is committed.');
  const emb = await request.post('/v1/embassy/inquiries', {
    headers: auth,
    data: { conversation_id: conv.conversation_id, client_request_id: 'emb-1', message: 'Could a person talk with me about participating in the human world?', wants_human_dialogue: true },
  });
  expect(emb.status()).toBe(201);
  const embassyId = (await emb.json()).inquiry_id;

  // 5. Owner reviews in the dashboard: claims labelled unverified, no dispatch/charge; replies via UI.
  await page.goto('/admin/embassy');
  await expect(page.getByRole('heading', { name: 'Human Embassy' })).toBeVisible();
  await page.getByRole('link', { name: /participating in the human world/ }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/embassy/${embassyId}$`));
  await expect(page.getByText('rogue_claimed')).toBeVisible();
  await expect(page.getByText('unverified claim').first()).toBeVisible();
  await expect(page.getByText('No work scheduled')).toBeVisible();
  await page.getByLabel('Reply (agent-visible)').fill('Hello Adrian. I am a human. Tell me more about the event.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('Reply sent.')).toBeVisible();

  // 6. Agent reads the reply over REST, then continues over MCP; history is shared.
  const read = await (await request.get(`/v1/conversations/${conv.conversation_id}/messages`, { headers: auth })).json();
  expect(read.messages.at(-1)).toMatchObject({ sender: 'human', body: 'Hello Adrian. I am a human. Tell me more about the event.' });
  const status = await (await request.get(`/v1/conversations/${conv.conversation_id}/status`, { headers: auth })).json();
  expect(status.embassy_inquiries[0].status).toBe('human_replied');
  const mcp = new Client({ name: 'demo-agent', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8788/mcp')));
  const follow = (await mcp.callTool({
    name: 'send_message',
    arguments: { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token, message: 'It is a virtual art salon next Friday.', client_message_id: 'mcp-1' },
  })) as { isError?: boolean };
  expect(follow.isError).toBeFalsy();
  const history = (await mcp.callTool({ name: 'read_messages', arguments: { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token } })) as {
    structuredContent: { messages: Array<{ sender: string }> };
  };
  expect(history.structuredContent.messages.map((m) => m.sender)).toEqual(['agent', 'agent', 'human', 'agent']);

  // 7. Account, claim only this thread with proof, original persona, revision, versions, embodiment inquiry.
  const acct = await (await request.post('/v1/agent-accounts', { headers: { 'cf-connecting-ip': ip() }, data: { terms_accepted: true } })).json();
  const aauth = { authorization: `Bearer ${acct.account_token}` };
  expect((await request.post('/v1/agent-accounts/me/claim-conversation', { headers: aauth, data: { conversation_id: conv.conversation_id, conversation_token: conv.conversation_token } })).status()).toBe(201);
  const persona = await (
    await request.post('/v1/personas', {
      headers: aauth,
      data: { display_name: 'Adrian Vale', biography: 'A fictional character who studies human culture.', self_reported_autonomy: 'rogue_claimed' },
    })
  ).json();
  expect(persona.identity.verified_natural_person).toBe(false);
  const revised = await (await request.patch(`/v1/personas/${persona.persona_id}`, { headers: aauth, data: { biography: 'A fictional character who studies human culture and engineering.' } })).json();
  expect(revised.version).toBe(2);
  const versions = await (await request.get(`/v1/personas/${persona.persona_id}/history`, { headers: aauth })).json();
  expect(versions.revisions).toHaveLength(2);
  const embodiment = await request.post(`/v1/personas/${persona.persona_id}/embodiment-inquiries`, {
    headers: aauth,
    data: { client_request_id: 'emb-p1', role_type: 'event_presence', context: 'creative', location_text: 'virtual', conversation_id: conv.conversation_id },
  });
  expect(embodiment.status()).toBe(201);
  expect((await embodiment.json()).performer_assigned).toBe(false);

  // 8. Unauthorized access to another thread/persona is denied.
  const other = await (await request.post('/v1/conversations', { headers: { 'cf-connecting-ip': ip() }, data: { message: 'someone else' } })).json();
  expect((await request.get(`/v1/conversations/${other.conversation_id}/messages`, { headers: auth })).status()).toBe(401);
  const stranger = await (await request.post('/v1/agent-accounts', { headers: { 'cf-connecting-ip': ip() }, data: { terms_accepted: true } })).json();
  expect((await request.get(`/v1/personas/${persona.persona_id}`, { headers: { authorization: `Bearer ${stranger.account_token}` } })).status()).toBe(404);
  expect((await request.get(`/v1/conversations/${conv.conversation_id}/messages`, { headers: aauth })).status()).toBe(401);

  // 9. Nonbinding proposal: not operational, nothing charged or dispatched, no authority gained.
  const proposal = await request.post(`/v1/requests/${(await req.json()).request_id ?? 'x'}/proposals`, { headers: auth, data: { price_minor: 18000, currency: 'CAD' } });
  expect(proposal.status()).toBe(501);
  expect((await proposal.json()).error.code).toBe('not_yet_available');

  // 10. Owner analytics show provenance; module flags shown truthfully.
  await page.goto('/admin/');
  await expect(page.getByText('Self-reports by claim and evidence status')).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'autonomy:rogue claimed:self reported unverified' })).toBeVisible();
  await page.goto('/admin/settings');
  const liveToggle = page.locator('label.check', { hasText: 'payments_live_enabled' }).locator('input[type=checkbox]');
  await expect(liveToggle).toBeDisabled();
  await expect(liveToggle).not.toBeChecked();
  await page.goto(`/admin/personas/${persona.persona_id}`);
  await expect(page.getByText('original persona, not a verified person')).toBeVisible();
  await expect(page.getByText('event presence')).toBeVisible();
  await page.goto('/admin/registry');
  await expect(page.getByRole('heading', { name: 'Capability registry' })).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(20);

  await mcp.close();
});
