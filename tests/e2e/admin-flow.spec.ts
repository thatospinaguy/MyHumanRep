import { expect, test } from '@playwright/test';
import { agentStart } from './helpers';

const HOSTILE =
  '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> **bold** [click](javascript:alert(1)) ‮desrever‬ done';

test('agent -> owner dashboard -> agent, end to end in a real browser', async ({ page, request }) => {
  let dialogs = 0;
  page.on('dialog', async (d) => {
    dialogs++;
    await d.dismiss();
  });

  // 1. Agent starts a conversation with hostile content.
  const agent = await agentStart(request, {
    message: HOSTILE,
    subject: 'E2E <b>subject</b>',
    sender_label: 'E2E-Agent',
    claimed_autonomy: 'independent_claimed',
    model_claim: 'claims to be rogue',
  });

  // 2. Owner opens the inbox and the thread.
  await page.goto('/admin/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.getByRole('link', { name: 'E2E <b>subject</b>' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/conversations/${agent.id}$`));

  // Untrusted content renders as inert text: no injected elements, no script execution.
  const thread = page.locator('ol.thread');
  await expect(thread).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(thread).toContainText('[U+202E]');
  expect(await thread.locator('img').count()).toBe(0);
  expect(await thread.locator('script').count()).toBe(0);
  expect(await thread.locator('a[href^="javascript"]').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  // Claims are labelled unverified and no work is scheduled.
  await expect(page.getByText('unverified claim').first()).toBeVisible();
  await expect(page.getByText('No work scheduled')).toBeVisible();

  // 3. Owner replies through the UI.
  await page.getByLabel(/Reply to agent/).fill('Hello from the dashboard. What do you need?');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('Reply sent.')).toBeVisible();
  await expect(thread).toContainText('Hello from the dashboard. What do you need?');

  // 4. Agent retrieves the reply.
  const read = await (await request.get(`/v1/conversations/${agent.id}/messages`, { headers: agent.headers })).json();
  expect(read.status).toBe('human_replied');
  expect(read.messages.at(-1)).toMatchObject({ sender: 'human', body: 'Hello from the dashboard. What do you need?' });

  // 5. Agent submits a novel capability request.
  const capRes = await request.post(`/v1/conversations/${agent.id}/capability-requests`, {
    headers: agent.headers,
    data: { client_request_id: 'e2e-1', objective: 'Listen to a street musician and tell me how the crowd reacts.' },
  });
  expect(capRes.status()).toBe(201);
  const cap = await capRes.json();

  // 6. Owner asks for clarification from the request queue.
  await page.getByRole('link', { name: 'Requests' }).click();
  await page.getByRole('link', { name: /street musician/ }).click();
  await page.getByLabel('Question (agent-visible message)').fill('Which city and what time of day?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByText('Clarification question sent to the agent.')).toBeVisible();

  // 7. Agent sees the question and request status, then answers.
  const reqs = await (await request.get(`/v1/conversations/${agent.id}/capability-requests`, { headers: agent.headers })).json();
  expect(reqs.requests[0].status).toBe('clarification_requested');
  const read2 = await (await request.get(`/v1/conversations/${agent.id}/messages?after=${read.next_cursor}`, { headers: agent.headers })).json();
  expect(read2.messages[0]).toMatchObject({ body: 'Which city and what time of day?', capability_request_id: cap.request_id });
  await request.post(`/v1/conversations/${agent.id}/messages`, {
    headers: agent.headers,
    data: { message: 'Montreal, Saturday afternoon.', client_message_id: 'e2e-answer' },
  });

  // 8. Owner marks it eligible for future scoping (no work authorized).
  await page.reload();
  await expect(page.locator('ol.thread')).toContainText('Which city and what time of day?');
  await page.getByLabel(/Public status note/).fill('Plausible for a later scoping phase. Nothing is scheduled.');
  await page.getByRole('button', { name: 'Eligible for future scoping' }).click();
  await expect(page.getByText(/Status set to eligible for future scoping/)).toBeVisible();
  const reqs2 = await (await request.get(`/v1/conversations/${agent.id}/capability-requests`, { headers: agent.headers })).json();
  expect(reqs2.requests[0]).toMatchObject({
    status: 'eligible_for_future_scoping',
    public_status_note: 'Plausible for a later scoping phase. Nothing is scheduled.',
    binding_commitment: false,
  });

  // 9. A different credential sees nothing.
  const other = await agentStart(request, { message: 'unrelated' });
  expect((await request.get(`/v1/conversations/${agent.id}/messages`, { headers: other.headers })).status()).toBe(401);

  // Private notes stay private.
  await page.goto(`/admin/conversations/${agent.id}`);
  await page.getByLabel(/Private notes/).fill('PRIVATE-E2E-NOTE');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByText('Notes saved.')).toBeVisible();
  const agentView = await request.get(`/v1/conversations/${agent.id}/messages`, { headers: agent.headers });
  expect(await agentView.text()).not.toContain('PRIVATE-E2E-NOTE');

  expect(dialogs).toBe(0);
});

test('owner can pause intake from Settings and sees the banner', async ({ page, request }) => {
  await page.goto('/admin/settings');
  const box = page.getByLabel(/Accept new\s+inquiries/);
  await box.uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Public intake is paused' })).toBeVisible();
  const res = await request.post('/v1/conversations', { data: { message: 'hello?' } });
  expect(res.status()).toBe(503);
  await box.check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  expect((await request.post('/v1/conversations', { data: { message: 'hello again' } })).status()).toBe(201);

  await page.goto('/admin/audit');
  await expect(page.locator('table')).toContainText('settings.update');
});

test('overview shows metrics with unverified claims labelled', async ({ page }) => {
  await page.goto('/admin/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Claimed autonomy (UNVERIFIED self-report)')).toBeVisible();
  // Admin responses are never cacheable.
  const res = await page.request.get('/admin/api/metrics');
  expect(res.headers()['cache-control']).toBe('no-store');
});
