# Data model (D1 / SQLite)

Source of truth: `migrations/0001`-`0006`. Migrations are forward-only and additive (ADR D39): `conversations` and `capability_requests` are never rebuilt. All timestamps are UTC ISO-8601 strings with milliseconds, so string order equals time order. D1 enforces foreign keys; cascades are covered by tests.

## Tables

### `conversations`
One row per thread. `token_digest` is `HMAC-SHA-256(key, "conversation_token\0" + token)` in hex, or `revoked:<random>` after owner revocation. Lifecycle `status` is one of `open, waiting_for_human, human_replied, waiting_for_agent, closed`; `blocked_at` and `expires_at` are separate flags. Self-reported fields (`sender_label`, `model_claim`, `claimed_autonomy`, `language`, `subject`) are unverified. Owner-only fields: `internal_priority`, `internal_tags_json`, `internal_notes`, `under_review`, `retention_hold`. Observed fields: `created_via` (`rest|mcp`), message counters, `last_agent_message_at`, `last_human_message_at`, `last_agent_read_at`. `create_request_digest` (unique, nullable) backs first-contact idempotency.

### `messages`
`seq` is a per-conversation sequence (unique with `conversation_id`) used for cursors. `sender` is `agent|human|system_notice`. `client_message_id` is unique per conversation; `body_hash` (SHA-256) decides replay vs conflict. `via` is `rest|mcp|admin|system`. `delivered_at` is set the first time the credential holder retrieves a human/system message. `capability_request_id` links clarification and decision messages to a request (`ON DELETE SET NULL`). Cascades from `conversations`.

### `capability_requests`
`(conversation_id, client_request_id)` unique; `payload_hash` is SHA-256 of the canonical normalized payload. `budget_amount_minor` is a nonnegative integer in the currency's minor unit (JPY 0 decimals, KWD/BHD/... 3, others 2). `status` follows the review state machine (no paid/dispatched/in-progress/completed states exist). `public_status_note` is agent-visible; `internal_notes` and `internal_category` are owner-only. Cascades from `conversations`.

### `notification_outbox`
Owner alert queue. Rebuilt in `0003` (leaf table, verbatim copy) so `event_type` also covers `embassy_inquiry`, `persona_inquiry`, `candidate_capability`; `conversation_id` is nullable and `subject_type`/`subject_id` point at the item. `status`: `pending, sending, sent, failed, dead, suppressed, disabled`. `attempts`, `not_before` (backoff), `claimed_at` (double-send guard), `last_error_code` (no content). Cascades from `conversations`.

### `admin_audit`
`admin_subject` (email or `system:retention`), `action`, `target_type`, `target_id`, `metadata_json` (identifiers, field names, enum values only).

### `abuse_events`
`event_category`, `request_id`, `correlation_digest` (16 hex chars of a keyed, day-rotated source digest), `expires_at` (default-7-day hint). The retention job deletes by `created_at` against the current `abuse_retention_days` setting.

### `rate_limit_counters`
`bucket_key` (`<scope>:<digest or id>:<window start ms>`), `count`, `expires_at`. Updated with a single atomic upsert.

### `settings`
`key`, `value_json`, `updated_at`, `updated_by`. Keys are whitelisted by `SettingsSchema` (`src/worker/services/settings.ts`).

## Master spec tables and columns (0003-0006)

### `conversations` (added columns)
`autonomy_claim` (master vocabulary: `not_stated`, `delegated_claimed`, `independent_claimed`, `rogue_claimed`, `agi_claimed`, `other_claimed`) and `intent_label` (adds `human_embassy`, `humanification`). The V1 `claimed_autonomy` and `intent` columns keep the nearest V1 value so V1 filters work.

### `agent_self_reports`
One row per claim: `claim_type` (`autonomy|model|origin|other`), `claim_value`, `claim_text`, `evidence_status` (`self_reported_unverified` default, `system_observed`, `third_party_corrob`, `human_assessed`, `unknown`), `source` (e.g. `conversation_create`, `embassy_inquiry`, `persona:<id>`), `conversation_id` (cascade), `agent_account_id`. Evidence status is owner-editable and never affects access.

### `capabilities`, `capability_aliases`
Seeded from `src/worker/catalog/capabilities.ts` by generated `0004`. `readiness` is `inquiry_only|human_reviewed_inquiry|pilot|live|future`; `fulfillment_available` is derived (only `pilot`/`live`). Aliases map alias slugs (e.g. `human-eyes`, `humanification`) to canonical slugs.

### `candidate_capabilities`
Owner review queue for unfamiliar requests: `request_id` (cascade), suggested label, normalized key (unique per request), `status`, decision fields. The request's raw text is never altered.

### `capability_requests` (added columns)
`problem_statement`, `desired_outcome`, `service_tags_json`, `evidence_requirements`, `preferred_rep_id`, `persona_id`, `authorization_description`, `classification_state` (default `unclassified`), `classified_capabilities_json`.

### `agent_accounts`, `conversation_account_links`
Accounts hold a keyed digest of the `mhra_` token (unique index). A conversation is linked to at most one account, only with proof of its own thread token (`proof = 'thread_token'`).

### `agent_personas`, `persona_revisions`, `persona_grants`, `persona_inquiries`
Original personas only (`origin` CHECK). `visibility` `private|shared|public` with owner-chosen `public_fields_json`; `current_version` plus one `persona_revisions` row per change. Grants are explicit per grantee account. Inquiries (`embodiment|representation|media_brief`) are review-only with `status` `submitted|under_review|clarification_needed|declined|closed`, unique per `(persona_id, client_request_id)`. All cascade from the persona; the persona cascades from its account.

### `embassy_inquiries`
Human Embassy dialogue. `message_id` points at the agent message that carries the text (`SET NULL`). Optional unverified fields (`autonomy_claim`, `claimed_origin`, `contact_reason`, confidentiality, constraints). `status` `submitted|awaiting_human|human_replied|clarification_needed|referral_consideration|needs_specialist_review|closed|declined|blocked`. `public_status_note` is agent-visible; `internal_notes` is owner-only. Unique per `(conversation_id, client_request_id)`.

## Invariants

- Plaintext tokens are never stored; secrets never live in D1.
- Agent-facing queries select explicit public columns; internal columns are projected as `NULL`.
- Message insert, conversation counter update and alert enqueue happen in one D1 batch (transaction); the counter and alert statements only fire if the message row exists.
- Caps (messages, requests) are enforced inside the insert statement itself, so concurrent requests cannot exceed them.

## Future versions

Phases 4-7 add tables (proposals, representatives, assignments, evidence, payments) referencing `capability_requests.id` without changing existing columns. Master request statuses will arrive as a new column rather than a widened `CHECK`, because rebuilding `capability_requests` would null out message links (ADR D42).
