import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

declare global {
  namespace Cloudflare {
    interface Env {
      MHR_DB: D1Database;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

await applyD1Migrations(env.MHR_DB, env.TEST_MIGRATIONS);

// Every test starts from an empty database (storage is shared within a test file).
beforeEach(async () => {
  await env.MHR_DB.batch(
    ['notification_outbox', 'capability_requests', 'messages', 'conversations', 'admin_audit', 'abuse_events', 'rate_limit_counters', 'settings'].map(
      (t) => env.MHR_DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});
