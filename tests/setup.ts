import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

declare global {
  namespace Cloudflare {
    interface Env {
      MHR_DB: D1Database;
      MIGRATION_DB: D1Database;
      CONVERSATION_TOKEN_HMAC_KEY: string;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

await applyD1Migrations(env.MHR_DB, env.TEST_MIGRATIONS);

// Registry seed statements, taken from the migration itself so tests use exactly what ships.
const registrySeed = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith('0004'))
  .flatMap((m) => m.queries)
  .map((q) => q.replace(/^\s*--.*$/gm, '').trim())
  .filter((q) => /^INSERT INTO capabilit/.test(q));

// Every test starts from an empty database (storage is shared within a test file), with the
// capability registry restored to its seeded state.
beforeEach(async () => {
  await env.MHR_DB.batch(
    ['persona_inquiries', 'persona_grants', 'persona_revisions', 'agent_personas', 'conversation_account_links', 'agent_accounts', 'candidate_capabilities', 'agent_self_reports', 'notification_outbox', 'capability_requests', 'messages', 'conversations', 'admin_audit', 'abuse_events', 'rate_limit_counters', 'settings'].map(
      (t) => env.MHR_DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.MHR_DB.batch([
    env.MHR_DB.prepare('DELETE FROM capability_aliases'),
    env.MHR_DB.prepare('DELETE FROM capabilities'),
    ...registrySeed.map((q) => env.MHR_DB.prepare(q)),
  ]);
});
