# Decisions log

Each entry: decision, why, and whether it deviates from the spec. D0-D38 were made against the original V1/V1.5 build spec (now `docs/archive/myhumanrep-claude-code-build-v2.md`). D39 onward are made against the master spec v4.0 (`docs/specs/MYHUMANREP_MASTER_SPEC.md`), which wins where they conflict.

## Starting point

- **D0. Greenfield build.** The repository was empty (no prior Agent Inbox code, migrations or secrets), so there was nothing to preserve or migrate. Both migrations are the initial schema.

## Versions (verified against the npm registry on 2026-10-30)

- **D1. MCP SDK v2: `@modelcontextprotocol/server` 2.4.0** (and `@modelcontextprotocol/client` 2.4.0 for tests). v2 is the stable line implementing the 2026-07-28 MCP spec; v1 (`@modelcontextprotocol/sdk` 1.32.x) tops out at 2025-11-25. We use `createMcpHandler`, a fetch-native, per-request (stateless) entry. *Follows the spec.*
- **D2. Legacy MCP clients are served** through the SDK's built-in stateless 2025 fallback (`legacy: 'stateless'`, the default). Both eras are tested with the official client in Vitest and against `wrangler dev` over real HTTP. GET/DELETE session operations return 405. *Spec allows legacy support only if documented and tested: it is both.*
- **D3. TypeScript 6.0.3, not 7.x.** `typescript-eslint` 8.72 supports TypeScript `<6.1`. Upgrade when typescript-eslint supports 7.
- **D4. `@cloudflare/vitest-plugin` 1.4 + Vitest 4.1.** `@cloudflare/vitest-pool-workers` is deprecated (renamed). Vitest 5 exists but the plugin's Vitest integration was validated on 4.1.
- **D5. Hono 4.13, Zod 4.6, jose 6.2, Wrangler 4.156, Vite 8.3, React 19.3, Playwright 1.63** (matches the preinstalled browser). `npm install` needed `--legacy-peer-deps` because of an npm arborist crash on optional peer sets (`Cannot read properties of null (reading 'edgesOut')`); the lockfile is committed so `npm ci` reproduces the tree.

## Architecture

- **D6. Public pages are server-rendered by the Worker (`hono/jsx`) instead of a React/Vite static build.** *Deviation.* Reasons: the spec requires pages to work without JavaScript; links must come from `PUBLIC_BASE_URL` per environment; retention numbers on `/privacy` must match live settings. Static HTML cannot do the last two without a per-environment build. The admin dashboard is React + Vite as specified.
- **D7. `run_worker_first: true` for all assets.** The only static assets are the admin SPA. Routing every request through the Worker guarantees Access verification before any admin file is served, security headers on every response, and alias-host redirects. Cost: one Worker invocation per asset request, acceptable at pilot scale.
- **D8. One shared service layer.** `src/worker/services/*` is the only business logic. REST routes and MCP tools are thin adapters. Capability-request REST routes live in `routes/conversations.ts` (not a separate file) since they share the auth wrapper.
- **D9. Settings in D1.** Owner-editable, non-secret settings (`intake_enabled`, retention windows, first-contact quotas, notifications on/off, paused message) live in a `settings` table and default from Worker vars. Secrets never touch D1.

## Agent API contract

- **D10. Unknown conversation and wrong token both return `401`** with an identical body, instead of `404` for unknown IDs. The spec says auth happens before data access and existence must not leak; a distinct 404 would leak it.
- **D11. Expired conversations return `410 expired` for reads and writes**, per the acceptance test "expired token cannot read any messages".
- **D12. Blocked conversations remain readable** (status `blocked`, `next_poll_after_seconds: null`) but reject writes with `403 forbidden` (`reason: conversation_blocked`). Closed conversations reject writes with `409 conflict` (`reason: conversation_closed`).
- **D13. Added `405 method_not_allowed`** to the error table (with `Allow` header) so `GET /v1/conversations?message=...` is explicitly refused rather than 404.
- **D14. Errors carry `error.details.reason`** (stable snake_case sub-code) and `error.details.issues[]` for validation, so agents can branch without parsing prose. Field names in validation messages are sanitized (no reflection of arbitrary keys).
- **D15. First-contact `client_request_id`:** optional. A repeat returns `409 duplicate_client_request_id`; the secret is never replayed (the spec's "safest default"). Stored as a keyed digest.
- **D16. Strict request schemas.** Unknown fields are rejected with an actionable message. `null` is accepted for optional fields.
- **D17. Message pagination uses a per-conversation `seq`** and an opaque cursor `c1.<base64url(seq)>`. Queries are always scoped by the authenticated conversation id, so a forged cursor can only move within the caller's own thread.
- **D18. Delivery is observed:** when the credential holder reads human/system messages, `delivered_at` is set. This powers the "successful round trip" metric from observed data, not claims.

## Security and abuse

- **D19. Conversation tokens:** `mhr_` + 32 random bytes (256 bits) base64url. Stored as HMAC-SHA-256 with purpose separation (`conversation_token\0<token>`), key in a Worker secret. Constant-time comparison (`crypto.subtle.timingSafeEqual`). `CONVERSATION_TOKEN_HMAC_KEY_PREVIOUS` is accepted during rotation. Admin can revoke a credential.
- **D20. Rate limiting is two-layer.** (a) Application quotas in D1: atomic fixed-window counters via a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (first contact per source/hour, global/day, per-thread ops/minute, MCP per source/minute, auth-failure lockout). (b) Optional Workers Rate Limiting binding `RL_PUBLIC` for a coarse edge layer. "Source" is a keyed, day-rotated digest of `CF-Connecting-IP`, never the raw IP.
- **D21. Admin CSRF:** writes require header `X-MHR-Admin: 1` (forces a CORS preflight that is never granted), plus `Origin` and `Sec-Fetch-Site` checks. Admin routes send no CORS headers.
- **D22. Admin search runs via `POST /admin/api/conversations/search`** so search text never lands in URLs or access logs. `GET /admin/api/conversations` keeps the filter-only listing from the spec.
- **D23. Local admin auth (`dev_insecure`)** exists only for development: honored only when `ENVIRONMENT=development` and the request host is localhost. Any other combination denies. Unknown `ENVIRONMENT` values are treated as production.
- **D24. MCP Origin validation** compares full origins against an allowlist (`PUBLIC_BASE_URL` origin + `MCP_ALLOWED_ORIGINS`). The request's own Host is not trusted (DNS rebinding). Requests without `Origin` (server-side clients) are allowed.
- **D25. MCP tool input validation:** the SDK validates tool arguments against the same Zod schemas before our handler runs and returns `isError: true` with the Zod message as text. Service-level failures (auth, state, limits) return a structured `{ error: {code, message, request_id, details}, http_status }` in `structuredContent`. Same rules, slightly different envelope for schema errors.
- **D26. Bidirectional control characters** are accepted in agent text (they are legitimate in RTL languages) but rendered as visible `[U+202E]` markers in the dashboard so they cannot reorder what the owner reads. C0/C1 control characters (other than tab/newline/CR) and lone surrogates are rejected.

## Notifications

- **D27. Provider-agnostic outbox** with providers `none`, `log`, `resend` (HTTPS API) and `cloudflare_email` (Workers `send_email` binding). Staging and production default to `none`: enabling real email is an owner decision. Alerts contain only event type, time and a dashboard link.
- **D28. Delivery:** opportunistic drain via `waitUntil` right after a commit, plus the `*/5` cron as backstop. Rows are claimed with a conditional update (no double sends). Backoff 1, 2, 4, 8, 16 minutes; dead-letter after 6 attempts; non-retryable errors dead-letter immediately. Blocked threads are suppressed. Follow-up alerts are coalesced to one pending alert per thread.

## Data and retention

- **D29. Schema additions beyond the reference schema:** `messages.seq`, `messages.via`, `messages.delivered_at`, `messages.capability_request_id`; conversation counters, `created_via`, `create_request_digest`, `internal_notes`, `under_review`, `retention_hold`, `closed_by`, `last_agent_read_at`; request `internal_category`, `created_via`; tables `rate_limit_counters`, `settings`; `CHECK` constraints on every enum column. All additive relative to the reference.
- **D30. Retention deletes rather than anonymizes** expired conversations after the grace period (cascade to messages, requests, outbox). Owner `retention_hold` exempts a thread. Audit 90 days, abuse signals 7 days, counters at window end.

## Discovery

- **D31. Added `/llms.txt`**, a plain-text summary of the same public facts as `/for-agents`. It contains no instructions to override anything. Not in the spec; low cost, helps text-only agents.
- **D32. No `.well-known` MCP server card.** I could not confirm a ratified well-known path in the 2026-07-28 spec, so none is published rather than guessing.
- **D33. `robots.txt` allows indexing only in production**; staging/development disallow everything.
- **D34. The Swarmchasers report is not cited on public pages.** The spec says to verify before citing; it was not verified here.

## Not implemented (by design or deferred)

- **D35.** Agent-initiated `withdraw` (spec: "optional later"). The status exists in the enum; no transition leads to it.
- **D36.** Human-visitor contact form (spec: optional).
- **D37.** "Allowed categories" admin setting: categories are free-form hints by design and never restricted.
- **D38.** `mcp-publisher` validation: the binary could not be downloaded here (GitHub API returned 403 through the sandbox proxy). `registry/server.json` is validated with Ajv against the official vendored schema (`registry/server.schema.2025-12-11.json`). Run `mcp-publisher` before publishing.

## Master spec v4.0 reconciliation

- **D39. Additive migrations only for parent tables.** D1 executes `DROP TABLE` with foreign keys enforced, so rebuilding `conversations` or `capability_requests` would cascade-delete messages or null out request links. New master fields are added as columns (`autonomy_claim`, `intent_label`, `classification_state`, ...). Only the leaf table `notification_outbox` was rebuilt, with a verbatim copy and a fixture test (T-071).
- **D40. Vocabulary mapping instead of renaming.** V1 `claimed_autonomy` values and intents keep working; master values (`rogue_claimed`, `agi_claimed`, `human_embassy`, ...) and free text are accepted too. `normalizeAutonomy` stores the master claim in `autonomy_claim` and keeps the closest V1 value in the legacy column so V1 filters and metrics stay valid.
- **D41. Claims are rows, not flags.** Every self-report (autonomy, model, origin) is an `agent_self_reports` row with `evidence_status` defaulting to `self_reported_unverified`. Owners can change evidence status; that never changes access, limits or routing.
- **D42. V1 request statuses kept.** The master status names differ, but changing the CHECK would need the rebuild ruled out in D39. Mapping is documented in REQUIREMENTS_RECONCILIATION. Still deferred after Phase 4 (see D53); will be an added column.
- **D43. Idempotency hash compatibility.** New capability-request fields join the payload hash only when non-null, so a V1 client replaying a V1 payload gets the same hash and a `200` replay, not a `409`.
- **D44. Registry generated from code.** `src/worker/catalog/capabilities.ts` is the single source; `npm run gen:capabilities` writes migration `0004`. After `0004` reaches a remote DB, changes go in new migrations. The Worker falls back to the static catalog if the table is empty.
- **D45. Account credentials separate from thread credentials.** `mhra_` account tokens and `mhr_` thread tokens use different HMAC purposes and cannot be swapped. Linking a thread requires both tokens. An account never gains access to a thread it did not prove.
- **D46. Persona visibility is presentation, not authentication.** `public`/`shared` controls which fields others see; writes always require the owner's account token. Grants are explicit and revocable.
- **D47. Embassy inquiries ride on ordinary messages.** The inquiry text is stored as an agent message (`client_message_id = embassy:<client_request_id>`), so the human reply, polling, MCP and admin threads work unchanged.
- **D48. Server-side feature flags with locked modules.** Flags live in the `settings` table. Flags for modules with no code are `implemented: false`: the admin API refuses to enable them (`400 invalid_request`), and their routes return `501 not_yet_available`. Payments additionally need written owner approval.
- **D49. Later-phase routes exist as typed 501s.** Agents reading the spec can call proposal, project, result and Human Lab routes and get an honest machine-readable answer with a hint, instead of a 404 or fake success.
- **D50. MCP tool names are additive.** V1 tools (`read_conversation`, `request_human_capability`, ...) stay; master names (`read_messages`, `describe_human_need`, `continue_conversation`, ...) are added as aliases over the same services.

## Phase 4

- **D51. Proposals are immutable revisions plus a guarded state row.** Each counteroffer inserts a `proposal_revisions` row keyed `(proposal_id, revision)`; that primary key makes concurrent counters fail instead of forking history. State changes are conditional updates on the status and revision the caller read.
- **D52. Any counter after agreement voids it.** The spec says prior approval is invalidated "where material". Every counter changes at least one term (empty counters are refused), and keeping an agreement pointed at an older revision would leave both sides unsure what was agreed, so the safer rule applies to all changes. Each revision still records `material_change` and `changed_fields`.
- **D53. Commercial status lives on proposals, not capability requests.** Spec 8.2 separates service status from commercial status. Proposals carry the negotiation state; request statuses stay the V1 set (D42).
- **D54. No authorize action exists.** `authorized` is in the schema so the state machine matches the spec, but neither the agent nor the owner API can set it. Authorization needs a verified principal, a contract and a payment flow (Phases 5-7). `request-authorization` only moves to `awaiting_authorization` for human review.
- **D55. Owner actions speak in the thread.** Owner counters, acceptances and decisions post an agent-visible human message linked to the request, so agents that only poll messages still learn about them. The message is guarded by thread state; if the thread closed mid-action, the proposal change stands and the API still shows it.
- **D56. Projects cite, they do not copy.** Project history returns IDs of messages, requests, proposal events and inquiries, never message text. Message bodies stay behind each conversation's own token, even for an account that claimed the thread. (Second sentence superseded by D60: an account now reaches threads it owns. Project history itself still cites IDs only.)
- **D57. Relationships stay requests until people exist.** A relationship needs a consenting human representative record, which arrives with the provider network (Phase 5). Until then the owner can review or decline, and activation returns 501.
- **D58. Consent templates are code, versioned and marked draft.** Like the capability registry, templates live in `src/worker/catalog/consent-templates.ts` with a version. They are served read-only and labelled `draft_requires_legal_review`; nothing is signed through the API.
- **D59. Proposal alerts reuse the `capability_request` outbox type.** Adding a new event type would mean rebuilding `notification_outbox` again. Proposal and relationship alerts use existing types with `subject_type` set, and the email label is chosen from the subject.

## Continuity (post-launch, 2026-10-31)

- **D60. An account reaches the threads it owns.** Agents lose context and restart; a per-thread secret the model must remember does not survive that, and it leaks through tool-argument logs. An account token now authorizes thread routes and tools for conversations linked to that account (`authenticateThread`). Ownership still needs proof: the thread token, either in a claim or because the thread was created in the same request as the account header (the token is issued to that caller). Unknown and unowned threads fail identically. Thread and account tokens keep separate HMAC purposes (D45). Supersedes the second sentence of D56.
- **D61. MCP reads only `mhra_` Authorization headers.** The header lets an operator keep the account token out of the model's context. Any other Authorization value is ignored as before, so clients behind gateways that add their own header keep working. With the header, `start_conversation` withholds the thread token (`conversation_token: null`); REST keeps returning it (V1 contract). Invalid headers fail per tool call, never as HTTP 401, which MCP clients would treat as an OAuth challenge.
- **D62. Long poll, not push.** Spec 14.5 forbids emailing senders or visiting their URLs, so replies are not pushed. `wait_for_reply` holds a request up to 25 s (below common MCP client timeouts of 60 s) and re-checks D1 every 2.5 s. Without `after` it waits for undelivered replies, which is what an agent that lost its cursor needs.
- **D63. Lost-token continuation is a claim, not recovery.** Spec 13.4 forbids passwordless recovery. `previous_conversation_id` is stored as an `other`/`continues_conversation` self-report (no migration), shown to the owner on both threads, and grants nothing. Its existence is never checked at intake, so it cannot be used to probe for conversation IDs.
