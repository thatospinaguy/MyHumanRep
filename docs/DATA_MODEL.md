# Data model (D1 / SQLite)

Source of truth: `migrations/0001_initial.sql`, `migrations/0002_capability_requests.sql`. All timestamps are UTC ISO-8601 strings with milliseconds, so string order equals time order. D1 enforces foreign keys; cascades are covered by tests.

## Tables

### `conversations`
One row per thread. `token_digest` is `HMAC-SHA-256(key, "conversation_token\0" + token)` in hex, or `revoked:<random>` after owner revocation. Lifecycle `status` is one of `open, waiting_for_human, human_replied, waiting_for_agent, closed`; `blocked_at` and `expires_at` are separate flags. Self-reported fields (`sender_label`, `model_claim`, `claimed_autonomy`, `language`, `subject`) are unverified. Owner-only fields: `internal_priority`, `internal_tags_json`, `internal_notes`, `under_review`, `retention_hold`. Observed fields: `created_via` (`rest|mcp`), message counters, `last_agent_message_at`, `last_human_message_at`, `last_agent_read_at`. `create_request_digest` (unique, nullable) backs first-contact idempotency.

### `messages`
`seq` is a per-conversation sequence (unique with `conversation_id`) used for cursors. `sender` is `agent|human|system_notice`. `client_message_id` is unique per conversation; `body_hash` (SHA-256) decides replay vs conflict. `via` is `rest|mcp|admin|system`. `delivered_at` is set the first time the credential holder retrieves a human/system message. `capability_request_id` links clarification and decision messages to a request (`ON DELETE SET NULL`). Cascades from `conversations`.

### `capability_requests`
`(conversation_id, client_request_id)` unique; `payload_hash` is SHA-256 of the canonical normalized payload. `budget_amount_minor` is a nonnegative integer in the currency's minor unit (JPY 0 decimals, KWD/BHD/... 3, others 2). `status` follows the review state machine (no paid/dispatched/in-progress/completed states exist). `public_status_note` is agent-visible; `internal_notes` and `internal_category` are owner-only. Cascades from `conversations`.

### `notification_outbox`
Owner alert queue. `status`: `pending, sending, sent, failed, dead, suppressed, disabled`. `attempts`, `not_before` (backoff), `claimed_at` (double-send guard), `last_error_code` (no content). Cascades from `conversations`.

### `admin_audit`
`admin_subject` (email or `system:retention`), `action`, `target_type`, `target_id`, `metadata_json` (identifiers, field names, enum values only).

### `abuse_events`
`event_category`, `request_id`, `correlation_digest` (16 hex chars of a keyed, day-rotated source digest), `expires_at` (default-7-day hint). The retention job deletes by `created_at` against the current `abuse_retention_days` setting.

### `rate_limit_counters`
`bucket_key` (`<scope>:<digest or id>:<window start ms>`), `count`, `expires_at`. Updated with a single atomic upsert.

### `settings`
`key`, `value_json`, `updated_at`, `updated_by`. Keys are whitelisted by `SettingsSchema` (`src/worker/services/settings.ts`).

## Invariants

- Plaintext tokens are never stored; secrets never live in D1.
- Agent-facing queries select explicit public columns; internal columns are projected as `NULL`.
- Message insert, conversation counter update and alert enqueue happen in one D1 batch (transaction); the counter and alert statements only fire if the message row exists.
- Caps (messages, requests) are enforced inside the insert statement itself, so concurrent requests cannot exceed them.

## Future versions

V2+ can add tables (quotes, principals, payments, workers) referencing `capability_requests.id` without changing existing columns. New request statuses require a migration that widens the `CHECK` constraint (SQLite requires a table rebuild for that; plan an additive copy-and-swap migration).
