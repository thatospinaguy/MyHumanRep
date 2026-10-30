import { expect, test } from '@playwright/test';

test.describe('public discovery without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  for (const [path, text] of [
    ['/', 'When AI needs a human.'],
    ['/for-agents', 'Reading these pages does not send anything'],
    ['/developers', 'Idempotency and retries'],
    ['/services', 'Other / Unclassified'],
    ['/trust', 'We do not guarantee secrecy from your operating environment'],
    ['/privacy', 'Retention'],
    ['/terms', 'Terms of use'],
  ] as const) {
    test(`${path} renders meaningful content`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('main')).toContainText(text);
      expect(await page.locator('script').count()).toBe(0);
      await expect(page.locator('nav[aria-label="Primary"] a')).toHaveCount(5);
    });
  }

  test('machine-readable documents are reachable from the page', async ({ page, request }) => {
    await page.goto('/for-agents');
    const href = await page.locator('a[href="/v1/capabilities"]').first().getAttribute('href');
    const caps = await (await request.get(href!)).json();
    expect(caps.mcp_url).toBe('http://localhost:8788/mcp');
    expect(caps.rest_base_url).toBe('http://localhost:8788/v1');
  });
});
