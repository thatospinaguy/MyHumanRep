# Test report

## Agent continuity run

Run date: 2026-10-31, local sandbox, branch `claude/jolly-lamport-f550gb`. Nothing ran against Cloudflare staging or production.

```text
typecheck: PASS   (worker + admin SPA)
lint: PASS        (eslint .)
vitest: PASS      (178/178, 16 files, Workers runtime, real local D1 with migrations 0001-0008)
playwright: PASS  (17/17, Chromium against a fresh wrangler dev + local D1)
build: PASS       (vite build + wrangler deploy --dry-run)
registry: PASS
```

| File | Tests | Spec IDs |
|---|---:|---|
| tests/integration/continuity.test.ts | 13 | T-007, T-012, T-013, T-017, T-020, T-024, T-038, T-039, T-059, T-060 |
| tests/e2e/master-demo.spec.ts | changed | step 8: claiming account reads its thread; stranger account and unowned thread still 401 (D60) |

## Master spec Phase 4 run

Run date: 2026-10-31, local sandbox, branch `claude/upbeat-mayer-9ipp4n`. Nothing ran against Cloudflare staging or production.

```text
typecheck: PASS   (worker + admin SPA)
lint: PASS        (eslint .)
vitest: PASS      (165/165, 15 files, Workers runtime, real local D1 with migrations 0001-0008)
playwright: PASS  (17/17, Chromium against a fresh wrangler dev + local D1; full suite run twice)
build: PASS       (vite build + wrangler deploy --dry-run)
registry: PASS
```

New and changed files:

| File | Tests | Spec IDs |
|---|---:|---|
| tests/integration/proposals.test.ts | 10 | T-047, T-048, T-049, T-050; scoping, expiry, limits, flag, owner create, MCP; regressions for expired proposals vs the open limit and a counter racing a withdrawal |
| tests/integration/projects.test.ts | 3 | Spec 10: cited history without message text or internal notes, account isolation, relationship requests (no activation, no authority), MCP |
| tests/integration/humanification.test.ts | 18 (+2) | Draft consent templates; T-058 disclosure by context |
| tests/integration/human-embassy.test.ts | 11 | Later-phase 501 list now covers results, Human Lab intake, representatives, payments |
| tests/integration/mcp.test.ts | 10 | Adds: discovery `mcp_tools` equals the served tool list |
| tests/e2e/phase4-negotiation.spec.ts | 1 | Phase 4 gate: browser owner + REST/MCP agent negotiate; no authorize button; nothing charged or dispatched |
| tests/e2e/master-demo.spec.ts | 1 | Step 9 now creates a real nonbinding proposal |

One e2e issue found and fixed while writing the gate test: the first full-suite run failed because every e2e test that does not set a client address shares the localhost source, and the edge limit (30 thread operations per minute per source) was exhausted across tests. The gate test now uses its own source address, as the first-contact helpers already did. Real agents have distinct sources.

## Master spec v4.0 run (Phases 0-3)

Run date: 2026-10-30, local sandbox, branch `claude/upbeat-mayer-9ipp4n`. Nothing ran against Cloudflare staging or production.

```text
typecheck: PASS   (worker + admin SPA)
lint: PASS        (eslint ., 93 files, 0 errors, 0 warnings)
vitest: PASS      (150/150, 13 files, Workers runtime, real local D1 with migrations 0001-0006)
playwright: PASS  (16/16, Chromium against a fresh wrangler dev + local D1)
build: PASS       (vite build + wrangler deploy --dry-run)
registry: PASS    (registry/server.json valid against the 2025-12-11 schema)
```

| File | Tests | Spec IDs |
|---|---:|---|
| tests/unit/core.test.ts | 20 | |
| tests/integration/master-accessibility.test.ts | 11 | T-001, T-002, T-003, T-004, T-007, T-009, T-010, T-011, T-022, T-067, T-069, T-071 |
| tests/integration/capability-registry.test.ts | 15 | T-006, T-007, T-025..T-029, T-059 |
| tests/integration/humanification.test.ts | 16 | T-034..T-043, T-046 |
| tests/integration/human-embassy.test.ts | 11 | T-003, T-005, T-011, T-020, T-030..T-033, T-047, T-049, T-056, T-069 |
| tests/integration/public.test.ts | 12 | T-001 (llms.txt), router-derived OpenAPI coverage |
| tests/integration/conversation-security.test.ts | 19 | V1 (T-012, T-013, T-016, T-021, T-023 behavior) |
| tests/integration/admin.test.ts | 13 | V1 (T-063..T-065 behavior) |
| tests/integration/notifications-retention.test.ts | 12 | V1 (T-066, T-068 behavior) |
| tests/integration/mcp.test.ts | 10 | V1 (T-060..T-062 behavior) |
| tests/integration/capability-requests.test.ts | 9 | V1.5 |
| tests/integration/rest-flow.test.ts | 1 | V1 demo |
| tests/integration/admin-races.test.ts | 1 | V1 |

Playwright (`tests/e2e/`): `admin-flow.spec.ts` (3), `public.spec.ts` (10, JavaScript disabled, including `/humanification` and `/human-embassy`), `mcp-client.spec.ts` (2, official client modern and legacy over real HTTP), `master-demo.spec.ts` (1, spec 20.7 demonstration).

Spec 20.7 demonstration, step by step (`tests/e2e/master-demo.spec.ts`):

1. `/for-agents` and `/v1/capabilities` fetched; 20 capabilities; `model_identity_required_for_inquiry: false`.
2-3. Conversation opened with a fictional name and `claimed_autonomy: rogue_claimed`; token only in the response body and header.
4. Unfamiliar request ("help my original persona attend a voluntary event") accepted as unclassified; Embassy inquiry with no task or budget accepted.
5. Owner opens the Embassy item in the browser, sees `rogue_claimed` labelled as an unverified claim and "No work scheduled", replies through the UI.
6. Agent reads the reply over REST; status shows `human_replied`; agent continues over MCP with the same token; history order agent, agent, human, agent.
7. Agent account created; thread claimed with proof; persona created (`verified_natural_person: false`), revised to version 2, history shows 2 revisions; embodiment inquiry accepted with `performer_assigned: false`.
8. Thread token cannot read another thread (401); another account cannot read the private persona (404); an account token cannot read the thread directly (401).
9. Proposal route returns `501 not_yet_available`: no charge, no dispatch.
10. Overview research view shows the claim with provenance; `payments_live_enabled` toggle is disabled and off; persona page shows "original persona, not a verified person"; registry lists 20 capabilities.

## V1/V1.5 baseline run

Run date: 2026-10-30, Node 22.22.0, local sandbox. Nothing below ran against Cloudflare production infrastructure.

## Summary

```text
Implemented:
- V1 public discovery, REST Agent Inbox, owner dashboard, notifications, retention
- V1.5 open-ended capability requests and review lifecycle
- Remote MCP server (2026-07-28 + stateless 2025 fallback) on the shared service layer

Verified locally:
- typecheck: PASS   (tsc -p tsconfig.json && tsc -p tsconfig.web.json)
- lint: PASS        (eslint ., 61 files, 0 warnings)
- unit: PASS        (20 tests, Vitest on the Workers runtime)
- integration: PASS (76 tests, Vitest on the Workers runtime with real local D1 + migrations)
- UI e2e: PASS      (13 tests, Playwright Chromium against wrangler dev + local D1)
- MCP compatibility: PASS (official TS client 2.4.0: modern 2026-07-28 and legacy 2025, in-process and over real HTTP)
- build: PASS       (vite build; wrangler deploy --dry-run for development, staging and production configs; 291.7 KiB gzip)
- registry metadata: PASS (registry/server.json valid against the official 2025-12-11 schema via Ajv 8)
- smoke scripts against wrangler dev: PASS (smoke-rest, smoke-mcp modern, smoke-mcp legacy, verify-openapi)
- cron handlers via wrangler dev /cdn-cgi/handler/scheduled: PASS (outbox_drain and retention_run logged)
- log hygiene: PASS (no tokens or message bodies in wrangler dev logs or captured Worker logs)

Not run / not verified:
- Any Cloudflare-hosted environment (no account access): remote D1, Access JWKS, custom domains, rate-limit binding, cron in production
- Real email delivery (Resend or Cloudflare Email)
- Third-party MCP clients (Claude Desktop/Code, others)
- mcp-publisher validate (binary not downloadable in the sandbox)
```

## Commands

```bash
npm run check
```

```bash
npm run test:e2e
```

```bash
BASE_URL=http://localhost:8787 node scripts/smoke-rest.ts
```

```bash
BASE_URL=http://localhost:8787 node scripts/smoke-mcp.ts modern
```

```bash
BASE_URL=http://localhost:8787 node scripts/verify-openapi.ts
```

## How the tests run

- Vitest uses `@cloudflare/vitest-plugin`, so code executes in `workerd` with a real local D1. Migrations from `migrations/` are applied once per file and every table is emptied before each test.
- Tests call the real Hono app with injectable clock, mailer and Access key resolver. Admin tests sign real RS256 JWTs with a generated key pair and go through the same `jwtVerify` path as production; one test also uses the production default export with no injected keys and confirms it fails closed.
- Playwright starts `wrangler dev` (port 8788) with a fresh local D1 and `dev_insecure` admin auth (honored only on localhost in development).

## Spec acceptance mapping (section 15)

| Spec item | Test(s) |
|---|---|
| Pages load over GET; meaningful without JS | public.test `serves meaningful, script-free HTML`; e2e `public discovery without JavaScript` |
| API/MCP URLs match configured base host | public.test `stable capability document built from the configured base URL`; e2e `machine-readable documents` |
| Read-only browsers told how contact works | public.test `tells read-only browsers...` |
| No hidden instructions / secrecy claims | public.test `contains no hidden instructions...` |
| Minimal create without registration | conversation-security `accepts a minimal message` |
| Rejects bad JSON, oversize, media type, blank, invalid fields | conversation-security `rejects malformed input...`; unit `input schemas` |
| Token random, once, not in D1 or logs | unit `issues 256-bit tokens`; conversation-security `stores only a keyed digest...` |
| Wrong/expired/missing token cannot read | conversation-security `rejects missing, malformed, wrong...`, `rejects mutations on ... expired` |
| A cannot read B | rest-flow step 9; conversation-security; mcp `same authorization rules`; e2e step 9 |
| Follow-up idempotency + 409 | conversation-security `makes follow-ups idempotent...` (incl. 10 concurrent retries) |
| Expired/blocked/closed reject mutations | conversation-security `rejects mutations on closed, blocked and expired...` |
| Pagination cannot escape thread | conversation-security `keeps pagination inside the authenticated thread` |
| 100 parallel first contacts, quotas, unique IDs | conversation-security `enforces per-source quotas across 100 parallel...` |
| Capability request without category; novel categories | capability-requests `accepts arbitrary objectives...` |
| Location/deadline/budget validation; minor units | capability-requests `validates location, deadline and budget...`; unit `money` |
| Request idempotency + 409 | capability-requests `is idempotent on identical payloads...` |
| Agent sees only public status and owner-intended messages | capability-requests `exposes only public fields...` |
| Clarification in linked conversation | rest-flow steps 5-6; e2e steps 6-7 |
| Decline without scheduling work | capability-requests `declines with a public explanation...` |
| No payment/dispatch/external action | capability-requests `offers no route to payment...`; unit `has no fulfillment states` |
| Unauthenticated admin UI/API blocked | admin `rejects unauthenticated access...` |
| Forged/expired/wrong-aud/missing JWT fails closed | admin `rejects forged, expired...`, `denies everything when Access is misconfigured`, `fails closed through the production default export` |
| Owner reply/status/private note/close/block | admin `replies, sets status...`; e2e flow |
| Private notes never public | capability-requests `exposes only public fields`; e2e private note check |
| Malicious HTML/Markdown/control chars inert | conversation-security `accepts hostile text as inert data`; e2e XSS/bidi checks |
| Notification failure retried, no rollback | notifications `retries transient failures...` |
| Blocked thread: no unlimited retries | notifications `suppresses alerts for blocked threads...` |
| Exports access-controlled, redacted, audited | admin `exports with audit and without secrets...` |
| MCP negotiation + tools | mcp `negotiates, lists tools...` (both eras) |
| MCP shares validation/state/auth | mcp `applies the same authorization rules as REST` |
| Invalid origin / malformed JSON-RPC / unsupported version / invalid credential | mcp `MCP transport safety` suite |
| Real client against local endpoint | e2e `official MCP client (modern|legacy)...`; smoke-mcp |
| Legacy clients documented and tested | mcp legacy era suite; docs/MCP.md |
| 429 with Retry-After | conversation-security quota tests; mcp rate-limit test |
| no-store on private responses; no bodies in logs | conversation-security header and log assertions |
| Retention deletes test conversations correctly | retention `deletes expired conversations after the grace period...` |
| Export/delete handle linked rows | capability-requests `cascades...`; admin export/delete |
| Privacy copy matches config | retention `publishes retention values that match the configured settings` |
| No automated execution of links/code/requests | no such code path exists; capability-requests `offers no route...` |
| Required end-to-end demonstration (1-9) | rest-flow (REST), mcp (MCP), e2e admin-flow (real browser) |

## Bugs found and fixed by the suite during development

1. Admin SQL builder re-substituted already-numbered placeholders when a clause had several parameters (broke cursor pagination). Fixed in `services/admin.ts` (`Where.add`).
2. Retention reported cascaded child rows as deleted conversations (D1 `meta.changes` counts cascades). Fixed with `DELETE ... RETURNING id`.
3. Invisible Unicode separators had been written literally into regex source. Replaced with escapes; added a scan.
4. (PR review) Reading with a cursor that skipped unread human messages marked them delivered too. Fixed with a lower `seq` bound; regression test added.
5. (PR review) The `abuse_retention_days` setting was not applied (events always kept 7 days). Retention now deletes by `created_at` against the current setting; regression test added.
6. (PR review) An owner reply, clarification or decision message racing an agent close could leave a closed thread with an open status. Admin message inserts are now conditional on live state and dependent updates/audit only fire if the insert did; `admin-races.test.ts` simulates the race.

## Vitest cases (96; list below predates the three PR-review regression tests)

### `tests/integration/admin.test.ts` (13)

- PASS: admin authentication (fails closed) > rejects unauthenticated access to the API and the UI
- PASS: admin authentication (fails closed) > rejects forged, expired, wrong-audience, wrong-issuer and non-admin assertions
- PASS: admin authentication (fails closed) > denies everything when Access is misconfigured, never defaulting open
- PASS: admin authentication (fails closed) > only allows dev_insecure in development on localhost
- PASS: admin authentication (fails closed) > rejects agent credentials on admin routes
- PASS: admin authentication (fails closed) > requires CSRF protections on admin writes
- PASS: admin authentication (fails closed) > fails closed through the production default export when Access keys cannot be fetched
- PASS: admin operations > lists, filters, searches (via POST) and paginates the inbox
- PASS: admin operations > replies, sets status, adds private notes, closes, reopens, blocks and extends
- PASS: admin operations > exports with audit and without secrets, and deletes only with confirmation and no hold
- PASS: admin operations > never writes message bodies or notes into audit metadata
- PASS: admin operations > validates and audits settings changes
- PASS: admin operations > reports metrics with claimed fields labelled unverified

### `tests/integration/capability-requests.test.ts` (9)

- PASS: open-ended capability requests > accepts arbitrary objectives with no, known, or novel category hints
- PASS: open-ended capability requests > validates location, deadline and budget and stores integer minor units
- PASS: open-ended capability requests > is idempotent on identical payloads and rejects conflicting reuse
- PASS: open-ended capability requests > exposes only public fields and owner-intended notes to the agent
- PASS: open-ended capability requests > declines with a public explanation and schedules nothing
- PASS: open-ended capability requests > posts an optional agent-visible message atomically with a decision
- PASS: open-ended capability requests > enforces active and lifetime caps per conversation
- PASS: open-ended capability requests > offers no route to payment, dispatch or external action
- PASS: open-ended capability requests > cascades capability requests and messages when a conversation is deleted

### `tests/integration/conversation-security.test.ts` (18)

- PASS: first contact > accepts a minimal message with no registration
- PASS: first contact > rejects malformed input with actionable machine-readable errors
- PASS: first contact > never accepts writes over GET or via query strings
- PASS: first contact > stores only a keyed digest of the token and never logs bodies or tokens
- PASS: first contact > enforces per-source quotas across 100 parallel first contacts without duplicate ids
- PASS: first contact > enforces a global daily cap
- PASS: first contact > rejects duplicate first-contact client_request_id without replaying the secret
- PASS: first contact > returns 503 when intake is paused while existing threads keep working
- PASS: first contact > fails closed with 503 when the HMAC key is missing
- PASS: conversation credentials and isolation > rejects missing, malformed, wrong and cross-thread tokens identically
- PASS: conversation credentials and isolation > locks out a source after repeated authentication failures
- PASS: conversation credentials and isolation > keeps pagination inside the authenticated thread
- PASS: conversation credentials and isolation > makes follow-ups idempotent and rejects conflicting replays
- PASS: conversation credentials and isolation > rejects mutations on closed, blocked and expired threads, and on message limit
- PASS: conversation credentials and isolation > honours admin credential revocation
- PASS: conversation credentials and isolation > rate limits operations per thread
- PASS: conversation credentials and isolation > uses the edge rate limiter binding when bound
- PASS: conversation credentials and isolation > accepts hostile text as inert data

### `tests/integration/mcp.test.ts` (10)

- PASS: MCP over Streamable HTTP (modern era) > negotiates, lists tools and runs the full agent -> human -> agent flow
- PASS: MCP over Streamable HTTP (modern era) > applies the same authorization rules as REST
- PASS: MCP over Streamable HTTP (legacy era) > negotiates, lists tools and runs the full agent -> human -> agent flow
- PASS: MCP over Streamable HTTP (legacy era) > applies the same authorization rules as REST
- PASS: MCP transport safety > rejects a disallowed Origin
- PASS: MCP transport safety > accepts the canonical Origin
- PASS: MCP transport safety > rejects GET, wrong content type, oversize and malformed JSON-RPC
- PASS: MCP transport safety > answers an unsupported modern protocol version with an error naming supported versions
- PASS: MCP transport safety > negotiates a legacy initialize with an unknown version down to a supported one
- PASS: MCP transport safety > rate limits MCP per source with 429 and Retry-After

### `tests/integration/notifications-retention.test.ts` (11)

- PASS: owner notifications > enqueues alerts for first contact, follow-ups and requests, delivered without content
- PASS: owner notifications > retries transient failures with backoff and never rolls back the inbound message
- PASS: owner notifications > dead-letters after bounded attempts and surfaces it in metrics
- PASS: owner notifications > does not retry non-retryable failures
- PASS: owner notifications > suppresses alerts for blocked threads instead of retrying forever
- PASS: owner notifications > coalesces a burst of follow-ups into one pending alert
- PASS: owner notifications > marks alerts disabled when notifications are switched off
- PASS: owner notifications > drains the outbox and runs retention from the scheduled handler
- PASS: retention > deletes expired conversations after the grace period, honoring holds and extensions
- PASS: retention > purges short-lived abuse signals, counters and old audit records
- PASS: retention > publishes retention values that match the configured settings

### `tests/integration/public.test.ts` (11)

- PASS: public discovery > serves meaningful, script-free HTML pages over plain GET
- PASS: public discovery > contains no hidden instructions, manipulation or secrecy claims
- PASS: public discovery > tells read-only browsers how contact works without implying GET can send
- PASS: public discovery > includes the required privacy wording on trust, developer docs and machine-readable docs
- PASS: public discovery > returns a stable capability document built from the configured base URL
- PASS: public discovery > publishes an OpenAPI 3.1 document covering every agent route
- PASS: public discovery > exposes minimal health, robots, sitemap and llms.txt
- PASS: public discovery > answers unknown routes with 404 (HTML for pages, JSON for APIs)
- PASS: public discovery > supports CORS preflight for browser-based agents without credentials
- PASS: public discovery > redirects alias hosts to the canonical host and strips private query strings
- PASS: public discovery > enables HSTS only when configured

### `tests/integration/rest-flow.test.ts` (1)

- PASS: Agent REST flow (end to end through the admin API) > runs the required agent -> human -> agent demonstration

### `tests/unit/core.test.ts` (20)

- PASS: conversation state machine > follows the canonical lifecycle
- PASS: conversation state machine > rejects every write on a closed conversation except reopen
- PASS: capability request state machine > allows only review transitions
- PASS: capability request state machine > has no fulfillment states in this release
- PASS: crypto helpers > issues 256-bit tokens and 128-bit ids that do not repeat
- PASS: crypto helpers > compares in constant time semantics
- PASS: crypto helpers > separates HMAC purposes
- PASS: crypto helpers > produces canonical JSON independent of key order
- PASS: money > stores integer minor units by currency exponent
- PASS: cursors and bearer parsing > round-trips and rejects tampering
- PASS: cursors and bearer parsing > parses Authorization headers strictly
- PASS: input schemas > requires only message for first contact
- PASS: input schemas > rejects blank, oversized, control characters, lone surrogates and unknown fields
- PASS: input schemas > requires client_message_id on follow-ups
- PASS: input schemas > accepts any category hint and validates budget pairing
- PASS: config > only honors dev_insecure admin auth in development
- PASS: config > defaults intake to closed and ignores invalid limit overrides
- PASS: owner alerts > never include message content, claims or credentials
- PASS: owner alerts > backs off exponentially with a bounded number of attempts
- PASS: CSV export > neutralizes formula injection and quotes safely

## Playwright cases (13)

- PASS: agent -> owner dashboard -> agent, end to end in a real browser (hostile HTML and bidi text inert, reply, clarification, eligible for scoping, cross-token isolation, private notes)
- PASS: owner can pause intake from Settings and sees the banner (503 while paused; audit row)
- PASS: overview shows metrics with unverified claims labelled
- PASS: official MCP client (modern) completes the flow against wrangler dev over real HTTP
- PASS: official MCP client (legacy) completes the flow against wrangler dev over real HTTP
- PASS: 7 public pages render meaningful content with JavaScript disabled
- PASS: machine-readable documents are reachable from the page
