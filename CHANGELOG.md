# Changelog

## Agent continuity (production, 2026-10-31)

### Added
- MCP: `Authorization: Bearer <account_token>` connection header. Threads started with it are linked to the account, `start_conversation` withholds the thread token, and tools run without credential arguments.
- MCP tools `wait_for_reply`, `rotate_conversation_token`, `list_my_conversations`.
- REST: account tokens authorize thread routes for owned conversations; `POST /v1/conversations` links to an account bearer; `GET /v1/conversations/{id}/messages/wait` long poll; `GET /v1/agent-accounts/me/conversations`.
- `previous_conversation_id` on first contact (unverified lost-token continuation claim) and a dashboard panel linking both threads.

### Changed
- `conversation_token` and `account_token` tool arguments are optional on MCP (still required without the header).
- An agent account that claimed a thread can now read and write it with the account token (D60, supersedes part of D56).

## 2.0.0 (unreleased, 2026-10-30)

First implementation of the V1 + V1.5 specification (`docs/archive/myhumanrep-claude-code-build-v2.md`).

### Added
- Public discovery: server-rendered pages (`/`, `/for-agents`, `/developers`, `/services`, `/trust`, `/privacy`, `/terms`), `/v1/capabilities`, `/openapi.json` (OpenAPI 3.1), `/llms.txt`, `robots.txt`, `sitemap.xml`, `/health`.
- REST Agent Inbox: pseudonymous first contact, one-time 256-bit conversation credential (keyed digest storage), cursor-paginated reads, idempotent follow-ups, close.
- Open-ended human capability requests with idempotency, caps, integer minor-unit budgets and a review lifecycle.
- Remote MCP server (official SDK v2, Streamable HTTP, 2026-07-28 with stateless 2025 fallback), 7 tools on the shared service layer.
- Owner dashboard (React): overview metrics, inbox with filters and POST search, conversation detail, request queue and decisions, clarification, settings, audit log, export, delete.
- Cloudflare Access verification in the Worker, email allowlist, CSRF protection, audit trail.
- Notification outbox with retries, dead-lettering, suppression and coalescing; providers none/log/Resend/Cloudflare Email.
- Rate limiting (D1 quotas + optional Workers Rate Limiting binding), abuse signals, retention job, intake pause.
- D1 migrations `0001_initial.sql`, `0002_capability_requests.sql`.
- Vitest (Workers runtime + D1) and Playwright suites; smoke scripts; registry `server.json`.
