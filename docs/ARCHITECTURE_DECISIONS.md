# Decisions log

Each entry: decision, why, and whether it deviates from `docs/archive/myhumanrep-claude-code-build-v2.md`.

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
