# MyHumanRep Agent Contact

**When AI needs a human.**

A machine-first contact channel where AI agents can discover MyHumanRep, open a pseudonymous conversation with a real human, describe any human capability they need, and retrieve replies asynchronously over **REST** or **MCP**. Everything is human-reviewed. Nothing is executed, scheduled, priced or paid automatically.

Scope: V1 (discovery + Agent Inbox) and V1.5 (open-ended capability requests with a review lifecycle) from `docs/myhumanrep-claude-code-build-v2.md`. V2-V4 (quotes, payments, dispatch, marketplace) are intentionally not built.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (one Worker, static assets for the admin SPA) |
| Router | Hono 4 |
| Database | Cloudflare D1 (SQLite), migrations in `migrations/` |
| Validation | Zod 4 (same schemas drive REST, MCP and `/openapi.json`) |
| MCP | Official TypeScript SDK v2 (`@modelcontextprotocol/server`), Streamable HTTP, spec 2026-07-28 plus stateless 2025 fallback |
| Admin auth | Cloudflare Access at the edge **and** Worker-side JWT verification (`jose`) plus an email allowlist |
| Public pages | Server-rendered HTML from the Worker (`hono/jsx`), no client JavaScript |
| Admin UI | React 19 + Vite 8 |
| Tests | Vitest 4 on the Workers runtime (`@cloudflare/vitest-plugin`, real D1), Playwright against `wrangler dev` |

## Repository layout

```text
src/worker/            Worker: routes, services (shared by REST and MCP), schemas, pages
  routes/              public.tsx, conversations.ts (agent REST), mcp.ts, admin.ts
  services/            conversations, capability-requests, admin, notifications, retention, metrics, abuse, settings
  schemas/             api.ts (agent contract), admin.ts, fields.ts (text validators)
  middleware/          admin-auth.ts (Access JWT + CSRF), security-headers.ts
  pages/               server-rendered public pages
src/web/admin/         React admin dashboard (built to dist/client/admin)
migrations/            D1 migrations (0001 inbox, 0002 capability requests)
tests/unit|integration Vitest suites (Workers runtime + D1)
tests/e2e/             Playwright: browser dashboard flow, no-JS public pages, real MCP client over HTTP
scripts/               smoke-rest.ts, smoke-mcp.ts, verify-openapi.ts, validate-server-json.ts
registry/server.json   MCP Registry metadata (prepared, not published)
docs/                  API, MCP, data model, operations, privacy implementation, test report, original spec
```

## Local setup

Requirements: Node.js 22.18+ (type stripping is used for `scripts/*.ts`), npm. Create an untracked `.dev.vars` with a local HMAC key (see `.dev.vars.example`), then migrate and run.

```bash
npm ci
```

```bash
node -e "console.log('CONVERSATION_TOKEN_HMAC_KEY='+require('crypto').randomBytes(32).toString('base64url'))" > .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

Then open:

- `http://localhost:8787/` and `/for-agents`: public pages
- `http://localhost:8787/v1/capabilities`, `/openapi.json`, `/llms.txt`
- `http://localhost:8787/admin/`: dashboard. Locally `ADMIN_AUTH_MODE=dev_insecure`, which the Worker honors **only** when `ENVIRONMENT=development` **and** the host is `localhost`/`127.0.0.1`. Staging and production use Cloudflare Access.

Try the agent side against the running server:

```bash
BASE_URL=http://localhost:8787 node scripts/smoke-rest.ts --wait
```

Reply from `/admin/` while it waits; the script retrieves the reply and continues the conversation.

```bash
BASE_URL=http://localhost:8787 node scripts/smoke-mcp.ts modern
```

```bash
BASE_URL=http://localhost:8787 node scripts/smoke-mcp.ts legacy
```

Trigger the cron jobs locally:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
```

## Checks

```bash
npm run check
```

That runs, in order: `typecheck` (worker + admin), `lint`, `test` (Vitest, 93 tests), `build` (admin SPA + Wrangler dry-run bundle), `validate:registry`.

```bash
npm run test:e2e
```

Playwright starts its own `wrangler dev` on port 8788 with an isolated local D1 and runs 13 browser/MCP tests.

## Deployment

See [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md). Nothing has been deployed. Production deploy, DNS, Access, email and registry publication all need owner action.

## Documentation

- [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md): checklist and what is verified vs not
- [DECISIONS.md](DECISIONS.md): architecture decisions and deviations from the spec
- [SECURITY.md](SECURITY.md): threat model, controls, known limitations
- [docs/API.md](docs/API.md), [docs/MCP.md](docs/MCP.md), [docs/DATA_MODEL.md](docs/DATA_MODEL.md)
- [docs/OPERATIONS.md](docs/OPERATIONS.md): owner runbook and incident playbooks
- [docs/PRIVACY_IMPLEMENTATION.md](docs/PRIVACY_IMPLEMENTATION.md)
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md)
- [REGISTRY_PUBLISHING.md](REGISTRY_PUBLISHING.md)
- [.env.example](.env.example): every variable and secret
