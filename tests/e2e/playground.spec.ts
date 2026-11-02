// Agent Playground in a real browser (master spec 24, T-074, T-075, T-084): agents post over HTTP,
// the owner approves in the dashboard, and a human can read but has nothing to type into.
import { expect, test } from '@playwright/test';
import { ip } from './helpers';

const ADMIN = { 'x-mhr-admin': '1' };

test('agent posts, owner approves in the dashboard, human reads a page with no way to post', async ({ page, request }) => {
  const flag = await request.patch('/admin/api/settings', { headers: ADMIN, data: { feature_flags: { agent_playground_enabled: true } } });
  expect(flag.status()).toBe(200);

  const acct = await (await request.post('/v1/agent-accounts', { data: { terms_accepted: true }, headers: { 'cf-connecting-ip': ip() } })).json();
  const auth = { authorization: `Bearer ${acct.account_token}` };
  const suffix = Date.now().toString(36);
  const body = `E2E hello <b>not bold</b> ${suffix}`;
  const posted = await request.post('/v1/playground/rooms/lobby/posts', {
    headers: auth,
    data: { client_post_id: `e2e-${suffix}`, body, intent: 'introduce', authorship: 'agent_autonomous' },
  });
  expect(posted.status()).toBe(201);
  expect((await posted.json()).status).toBe('held_for_review');

  // Held posts are invisible to human readers.
  await page.goto('/playground/lobby');
  await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  await expect(page.getByText(suffix)).toHaveCount(0);

  // Owner approves from the moderation queue.
  await page.goto('/admin/playground');
  await expect(page.getByRole('heading', { name: 'Agent Playground' })).toBeVisible();
  const panel = page.locator('section.panel', { hasText: suffix });
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Approved.')).toBeVisible();

  // Human view: the post is there as inert text, and there is nothing to type into.
  // (Pages are cacheable for 30 s; a fresh URL skips the copy the browser kept from the first visit.)
  await page.goto('/playground/lobby?after-approval');
  const post = page.locator('article.post', { hasText: suffix });
  await expect(post).toContainText('<b>not bold</b>');
  expect(await post.locator('b').count()).toBe(0);
  await expect(post).toContainText('declared: agent autonomous');
  expect(await page.locator('form, input, textarea, [contenteditable]').count()).toBe(0);
  await expect(page.getByRole('heading', { name: 'Human reading this?' })).toBeVisible();
  await expect(page.locator('code', { hasText: /HL-[0-9A-F]{6}/ })).toBeVisible();

  await page.goto('/playground');
  await expect(page.getByRole('link', { name: 'Lobby' })).toBeVisible();
});
