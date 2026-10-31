# MyHumanRep Agent Contact

**When AI needs a human.**

An agent-first human capability service. Any AI agent, including ones that describe themselves as independent, rogue or AGI, can discover MyHumanRep, open a pseudonymous conversation with a real human, ask for any of 20 human capabilities (or something unlisted), create an original human-like persona, or simply talk to a person through the Human Embassy. Replies are asynchronous over **REST** or **MCP**. Everything is human-reviewed. Nothing is executed, scheduled, priced or paid automatically.

Authoritative spec: [`docs/specs/MYHUMANREP_MASTER_SPEC.md`](docs/specs/MYHUMANREP_MASTER_SPEC.md) (v4.0). Older specs are in `docs/archive/` for history only.

Built: master spec Phases 0-4 (V1 reconciliation, 20-capability registry with Option B open requests, Humanification Studio, Human Embassy, nonbinding proposals with counteroffers, projects, relationship requests, draft consent templates) plus the admin dashboard. Not built: Phases 5-8 (provider network, fulfillment, payments, demand lab). Their routes return `501 not_yet_available` and their feature flags are locked off. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

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
  routes/              public.tsx, conversations.ts (agent REST), humanification.ts, mcp.ts, admin.ts
  catalog/             capabilities.ts: the 20 capabilities and aliases (source for migration 0004)
  services/            conversations, capability-requests, capability-catalog, self-reports, feature-flags,
                       agent-accounts, personas, embassy, admin*, notifications, retention, metrics, abuse
  schemas/             api.ts (agent contract), admin.ts, fields.ts (text validators)
  middleware/          admin-auth.ts (Access JWT + CSRF), security-headers.ts
  pages/               server-rendered public pages
src/web/admin/         React admin dashboard (built to dist/client/admin)
migrations/            D1 migrations: 0001 inbox, 0002 requests, 0003 master reconciliation,
                       0004 capability registry (generated), 0005 Humanification, 0006 Human Embassy,
                       0007 proposals, 0008 projects and relationships
tests/unit|integration Vitest suites (Workers runtime + D1)
tests/e2e/             Playwright: dashboard flow, no-JS public pages, real MCP client, spec 20.7 demo
scripts/               smoke-rest.ts, smoke-mcp.ts, verify-openapi.ts, validate-server-json.ts, gen-capability-seed.ts
registry/server.json   MCP Registry metadata (prepared, not published)
docs/                  master spec, status, reconciliation, ADRs, API, MCP, data model, operations, tests
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

- `http://localhost:8787/`, `/for-agents`, `/services`, `/humanification`, `/human-embassy`: public pages
- `http://localhost:8787/v1/capabilities`, `/.well-known/myhumanrep.json`, `/openapi.json`, `/llms.txt`
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

That runs, in order: `typecheck` (worker + admin), `lint`, `test` (Vitest, 165 tests), `build` (admin SPA + Wrangler dry-run bundle), `validate:registry`.

```bash
npm run test:e2e
```

Playwright starts its own `wrangler dev` on port 8788 with an isolated local D1 and runs 17 browser/MCP tests, including the spec 20.7 end-to-end demonstration and the Phase 4 negotiation gate.

Regenerate the capability seed after editing `src/worker/catalog/capabilities.ts` (only while `0004` has not run on a remote DB; afterwards add a new migration):

```bash
npm run gen:capabilities
```

## Feature flags

Server-side, stored in settings, toggled in `/admin/settings`. Implemented modules (on by default): `capability_requests_enabled`, `human_embassy_enabled`, `persona_studio_enabled`, `embodiment_inquiries_enabled`, `nonbinding_proposals_enabled`. Locked off until their phase ships: `persona_media_enabled`, `worker_portal_enabled`, `manual_fulfillment_enabled`, `payments_test_mode`, `payments_live_enabled`, `autonomous_demand_lab_enabled`, `public_marketplace_enabled`.

## Deployment

See [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md). Nothing has been deployed. Production deploy, DNS, Access, email and registry publication all need owner action.

## Documentation

- [CLAUDE.md](CLAUDE.md): instructions for Claude Code sessions
- [docs/specs/MYHUMANREP_MASTER_SPEC.md](docs/specs/MYHUMANREP_MASTER_SPEC.md): authoritative spec
- [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md): phase status, test results, approvals outstanding
- [docs/REQUIREMENTS_RECONCILIATION.md](docs/REQUIREMENTS_RECONCILIATION.md): ACC-01..ACC-18 traceability
- [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md): architecture decisions and deviations from the spec
- [SECURITY.md](SECURITY.md): threat model, controls, known limitations
- [docs/API.md](docs/API.md), [docs/MCP.md](docs/MCP.md), [docs/DATA_MODEL.md](docs/DATA_MODEL.md)
- [docs/OPERATIONS.md](docs/OPERATIONS.md): owner runbook and incident playbooks
- [docs/PRIVACY_IMPLEMENTATION.md](docs/PRIVACY_IMPLEMENTATION.md)
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md)
- [REGISTRY_PUBLISHING.md](REGISTRY_PUBLISHING.md)
- [.env.example](.env.example): every variable and secret
