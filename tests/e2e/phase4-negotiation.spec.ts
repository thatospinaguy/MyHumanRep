// Master spec Phase 4 gate: multi-step dialogue and counteroffer visible to both sides; neither creates an actual
// charge or dispatch. Real browser for the owner, real REST and MCP clients for the agent, real wrangler dev.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { agentStart, ip } from './helpers';

test('Phase 4 gate: agent and owner negotiate a nonbinding proposal; nothing is charged, authorized or dispatched', async ({ page, request }) => {
  const started = await agentStart(request, { message: 'I need a person to photograph a storefront.', sender_label: 'Scout' });
  // One client source for this agent, so per-source edge limits are not shared with other e2e tests.
  const source = { 'cf-connecting-ip': ip() };
  const agent = { ...started, headers: { ...started.headers, ...source } };
  const req = await (
    await request.post(`/v1/conversations/${agent.id}/capability-requests`, {
      headers: agent.headers,
      data: { client_request_id: 'g1', objective: 'Photograph the storefront at 12 Main St and describe the signage.' },
    })
  ).json();
  const requestId = req.request_id as string;

  // 1. Agent proposes scope and price over REST.
  const created = await request.post(`/v1/requests/${requestId}/proposals`, {
    headers: agent.headers,
    data: {
      client_request_id: 'gp1',
      scope_text: 'Exterior photos of 12 Main St, no entry.',
      timing_text: 'Within 5 days',
      deliverables: ['Six daylight photos'],
      cancellation_terms: 'Free cancellation up to 24 hours before.',
      price: { amount_minor: 15000, currency: 'CAD' },
    },
  });
  expect(created.status()).toBe(201);
  const proposalId = (await created.json()).proposal_id as string;

  // 2. Owner finds it in the browser and counters with a higher price.
  await page.goto('/admin/proposals');
  await expect(page.getByRole('heading', { name: 'Proposals' })).toBeVisible();
  await page.getByRole('link', { name: /Exterior photos of 12 Main St/ }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/proposals/${proposalId}$`));
  await expect(page.getByText('Nonbinding · no charge · no dispatch')).toBeVisible();
  await expect(page.getByRole('button', { name: /authorize/i })).toHaveCount(0);
  await page.getByLabel('Price (nonbinding)').fill('220.00');
  await page.getByLabel('Message to the agent (optional)').fill('Our photographer needs a bit more for travel.');
  await page.getByRole('button', { name: 'Send counteroffer' }).click();
  await expect(page.getByText('Counteroffer sent.')).toBeVisible();

  // 3. Agent sees the counter in its thread (REST) and in proposal history (MCP), then counters timing over MCP.
  const msgs = await (await request.get(`/v1/conversations/${agent.id}/messages`, { headers: agent.headers })).json();
  expect(msgs.messages.at(-1).body).toContain('Our photographer needs a bit more for travel.');
  const mcp = new Client({ name: 'gate-agent', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8788/mcp'), { requestInit: { headers: source } }));
  type R = { isError?: boolean; structuredContent: Record<string, any> };
  const hist = (await mcp.callTool({ name: 'get_proposal_history', arguments: { conversation_token: agent.token, request_id: requestId } })) as R;
  expect(hist.structuredContent.proposals[0].current_terms).toMatchObject({ actor: 'human', price: { amount_minor: 22000, currency: 'CAD' } });
  const counter = (await mcp.callTool({
    name: 'counter_nonbinding_proposal',
    arguments: { conversation_token: agent.token, proposal_id: proposalId, client_request_id: 'gc1', timing_text: 'Within 10 days', note: 'Fine on price if timing can slip.' },
  })) as R;
  expect(counter.isError).toBeFalsy();
  expect(counter.structuredContent).toMatchObject({ current_revision: 3, awaiting: 'human', binding: false });

  // 4. Owner sees revision 3 and accepts it (nonbinding).
  await page.reload();
  // Every term is visible before acceptance, including ones carried over from earlier revisions.
  const current = page.locator('section.panel', { has: page.getByRole('heading', { name: /Current terms \(revision 3/ }) });
  await expect(current.getByText('Fine on price if timing can slip.')).toBeVisible();
  await expect(current.getByText('Six daylight photos')).toBeVisible();
  await expect(current.getByText('Free cancellation up to 24 hours before.')).toBeVisible();
  await expect(current.getByText('Within 10 days')).toBeVisible();
  await page.getByRole('button', { name: 'Accept revision 3' }).click();
  await expect(page.getByText('Terms accepted (nonbinding).')).toBeVisible();

  // 5. Agent requests authorization: review only.
  const auth = await (await request.post(`/v1/proposals/${proposalId}/request-authorization`, { headers: agent.headers, data: {} })).json();
  expect(auth).toMatchObject({ status: 'awaiting_authorization', authorization_available: false, charge_created: false, work_scheduled: false });

  // 6. Owner can only return it to negotiation or decline: there is no authorize action.
  await page.reload();
  await expect(page.getByRole('button', { name: /^authorize/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to negotiation' }).click();
  await expect(page.getByText('Returned to negotiation.')).toBeVisible();

  const final = await (await request.get(`/v1/proposals/${proposalId}`, { headers: agent.headers })).json();
  expect(final).toMatchObject({ status: 'terms_agreed_nonbinding', agreed_revision: 3, charge_created: false, work_scheduled: false });
  expect(final.events.map((e: { event_type: string }) => e.event_type)).toEqual([
    'created',
    'countered',
    'countered',
    'accepted_nonbinding',
    'authorization_requested',
    'returned_to_negotiation',
  ]);
  await mcp.close();
});
