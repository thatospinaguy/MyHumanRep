import { defineConfig } from '@playwright/test';

const PORT = 8788;
export const E2E_BASE = `http://localhost:${PORT}`;

// Runs the real Worker locally (wrangler dev + local D1) with an isolated state directory.
// Admin auth uses dev_insecure, which the Worker only honors in development on localhost.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: E2E_BASE, trace: 'off' },
  webServer: {
    command: [
      'rm -rf .wrangler/e2e',
      'npx vite build',
      'npx wrangler d1 migrations apply MHR_DB --local --persist-to .wrangler/e2e',
      `npx wrangler dev --port ${PORT} --persist-to .wrangler/e2e --var PUBLIC_BASE_URL:${E2E_BASE} --var LIMIT_FIRST_CONTACT_PER_SOURCE_PER_HOUR:1000 --var NOTIFY_PROVIDER:log --show-interactive-dev-session=false`,
    ].join(' && '),
    url: `${E2E_BASE}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
