import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Separate database used to replay migrations against a V1-era fixture (T-071).
          d1Databases: { MIGRATION_DB: 'mhr-migration-fixture' },
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only key. Real keys live in Wrangler secrets or an untracked .dev.vars.
            CONVERSATION_TOKEN_HMAC_KEY: 'test-only-hmac-key-0123456789abcdefghijklmnopqrstuvwxyz',
            NOTIFY_PROVIDER: 'none',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
      testTimeout: 30000,
    },
  };
});
