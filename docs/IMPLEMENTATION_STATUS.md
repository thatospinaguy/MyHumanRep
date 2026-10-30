# Implementation status

Legend: **Done** = implemented and covered by an executed automated test. **Done (manual)** = implemented and exercised locally, no dedicated automated test. **Not verified** = needs real infrastructure or owner credentials.

Last full run: 2026-10-30. Vitest 96/96, Playwright 13/13, typecheck, lint, build, registry schema validation all passing. Details in [docs/TEST_REPORT.md](TEST_REPORT.md).

## Phase 0: inventory and compatibility

| Item | Status |
|---|---|
| Repository inventory (empty repo, nothing to migrate, no secrets found) | Done |
| Current package versions checked; MCP SDK v2 selected (2026-07-28) | Done ([DECISIONS.md](ARCHITECTURE_DECISIONS.md) D1-D5) |
| DECISIONS.md, IMPLEMENTATION_STATUS.md | Done |

## Phase 1: foundation and public discovery

| Item | Status |
|---|---|
| Worker + Hono + D1, strict TypeScript | Done |
| `/`, `/for-agents`, `/developers`, `/services`, `/trust`, `/privacy`, `/terms` without JavaScript | Done (Vitest + Playwright with JS disabled) |
| `/v1/capabilities` from configured base URL | Done |
| `/openapi.json` (OpenAPI 3.1 generated from the Zod schemas) | Done (route coverage + `$ref` resolution tested; live check script) |
| `/health` minimal | Done |
| `robots.txt`, `sitemap.xml`, canonical/meta tags, `llms.txt` | Done |
| Security headers, CSP, HSTS flag | Done |
| No hidden instructions or secrecy claims | Done (pattern test over all public documents) |
| `.ca` alias redirect with private query stripping | Done (Worker-level; DNS is owner action) |

## Phase 2: REST Agent Inbox

| Item | Status |
|---|---|
| `POST /v1/conversations` atomic create (conversation + first message + outbox) | Done |
| 256-bit token, returned once, keyed HMAC digest only, constant-time compare | Done |
| `GET/POST /v1/conversations/{id}/messages`, cursor pagination, idempotency, 409 conflict | Done |
| `POST /v1/conversations/{id}/close` | Done |
| Expiry (410), closed (409), blocked (403), message cap (409) | Done |
| Thread isolation, enumeration resistance, auth-failure lockout | Done |
| 100 parallel first contacts, quota exactness, unique IDs | Done |
| Body caps, content-type, malformed JSON, invalid UTF-8, control chars, lone surrogates | Done |
| Token and bodies absent from D1 plaintext and logs | Done |

## Phase 3: owner dashboard and notifications

| Item | Status |
|---|---|
| Access JWT verification + allowlist, fails closed | Done (local keys; real Access **not verified**) |
| CSRF protection on admin writes | Done |
| Inbox: filters, POST search, pagination, columns per spec 10.2 | Done (API tests + browser) |
| Conversation detail: plain-text thread, unverified claims, reply, private notes, priority, tags, reclassify, close/reopen, block/unblock, extend, revoke credential, export, delete | Done |
| Request queue and detail: decisions, clarification, public vs private notes | Done |
| Settings (intake toggle, retention, quotas, notifications) with paused banner | Done |
| Audit list with filters and CSV export | Done |
| Overview metrics with observed vs claimed separation, CSV aggregates | Done |
| Notification outbox: retry/backoff, dead letter, suppression for blocked threads, coalescing, no content | Done |
| Real email delivery (Resend / Cloudflare Email) | **Not verified** (code paths exist; provider default `none`) |

## Phase 4: open-ended capability requests

| Item | Status |
|---|---|
| Schema, REST endpoints, linked to thread | Done |
| No category, novel category, location/deadline/budget validation, integer minor units | Done |
| Idempotency (payload hash) and 409 | Done |
| Active (10) and lifetime (30) caps | Done |
| Review state machine, invalid transitions rejected | Done |
| Clarification creates an agent-visible linked message atomically | Done |
| Decline sets a public note; nothing scheduled; no payment/dispatch routes | Done |
| Agent sees no internal notes/categories/tags | Done |
| Agent-initiated withdraw | Not implemented (spec: optional later) |

## Phase 5: remote MCP

| Item | Status |
|---|---|
| Streamable HTTP at `POST /mcp`, official SDK v2, stateless | Done |
| 7 tools sharing the REST services | Done |
| 2026-07-28 negotiation and 2025 legacy fallback | Done (both eras, Vitest + real HTTP against `wrangler dev`) |
| Origin, content type, size, method, malformed JSON-RPC, unsupported version | Done |
| Third-party MCP clients (Claude Desktop/Code, others) | **Not verified** |

## Phase 6: abuse, privacy, observability

| Item | Status |
|---|---|
| Rate limits: per source, global, per thread, MCP, auth lockout, optional edge binding | Done |
| Abuse events (short-lived, digest only) | Done |
| Structured logs without bodies/tokens/IPs/full IDs | Done (log capture test + dev log grep) |
| Retention job (grace period, holds, extensions, cascades, counters, audit) | Done |
| Published retention values follow settings | Done |
| Cron handlers | Done (Vitest scheduled controller + `wrangler dev` cron trigger) |

## Phase 7: release package

| Item | Status |
|---|---|
| Wrangler config for development/staging/production, dry-run bundles | Done (292 KiB gzip) |
| Migrations apply locally | Done |
| Migrations on remote D1 | **Not verified** (needs account) |
| Staging deploy and live smoke tests | **Not verified** (needs account + approval) |
| Registry `server.json` validated against official schema | Done (Ajv); `mcp-publisher` **not run** |
| README, DEPLOYMENT_CHECKLIST, SECURITY, OPERATIONS, API/MCP/DATA_MODEL/PRIVACY docs, TEST_REPORT | Done |

## Gap list

1. Cloudflare account resources (D1 IDs, Access app, secrets, custom domains) do not exist yet.
2. Email delivery untested against a real provider.
3. Real Access JWT path (remote JWKS) untested; local tests use generated RS256 keys through the same `jwtVerify` code.
4. Workers Rate Limiting binding behavior in production untested (binding is optional; app-level quotas are tested).
5. No third-party MCP client tested yet.
6. `mcp-publisher validate` not run; namespace `com.myhumanrep` needs DNS/HTTP verification at publish time.
7. Swarmchasers reference not verified, so not cited publicly.
