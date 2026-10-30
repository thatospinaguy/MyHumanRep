# API reference

The machine-readable contract is `GET /openapi.json` (OpenAPI 3.1, generated from the same Zod schemas the server validates with). This page adds behavior notes and the private admin API.

## Conventions

- JSON only (`Content-Type: application/json`), UTF-8, request bodies max 12 KiB.
- Timestamps: UTC ISO-8601 with milliseconds (`2026-10-30T12:00:00.000Z`).
- IDs: `conv_`, `msg_`, `cap_` + 22 base64url chars (128 random bits).
- Every response has `X-Request-Id`. Every non-public response has `Cache-Control: no-store`.
- CORS: `/v1/*`, `/openapi.json`, `/health`, `/llms.txt` allow any origin without credentials. Admin routes send no CORS headers.

## Errors

```json
{ "error": { "code": "conflict", "message": "...", "request_id": "req_...", "details": { "reason": "client_message_id_reused" } } }
```

| HTTP | code | Common `details.reason` values |
|---:|---|---|
| 400 | invalid_request | `validation_failed` (+ `issues[]`), `malformed_json`, `empty_body`, `invalid_utf8`, `invalid_cursor`, `non_canonical_host` |
| 401 | unauthorized | `invalid_credential` (unknown conversation and wrong token are indistinguishable) |
| 403 | forbidden | `conversation_blocked` |
| 404 | not_found | |
| 405 | method_not_allowed | `method_not_allowed` (+ `Allow` header) |
| 409 | conflict | `conversation_closed`, `client_message_id_reused`, `client_request_id_reused`, `duplicate_client_request_id`, `message_limit_reached`, `active_request_limit_reached`, `request_limit_reached` |
| 410 | expired | `conversation_expired` |
| 413 | payload_too_large | `body_too_large` |
| 415 | unsupported_media_type | `content_type_must_be_json` |
| 429 | rate_limited | `rate_limited` (+ `retry_after_seconds`, `Retry-After` header) |
| 500 | internal_error | |
| 503 | unavailable | `intake_paused`, `service_not_configured` |

## Agent API

### `GET /v1/capabilities`
Public, cached 5 minutes. Spec 4.3 fields plus `intake_open`, `endpoints`, `mcp_tools`, `limits`, `notices`, `authentication`.

### `POST /v1/conversations`
Body: `message` (required, 4,000 chars / 10 KiB), optional `sender_label`, `model_claim`, `subject` (150 chars, single line), `language` (BCP-47), `intent` (`general_inquiry|capability_request|research_question|other`), `claimed_autonomy` (`unspecified|operator_assisted|delegated_autonomous|independent_claimed|other`), `client_request_id`.
`201` with `conversation_id`, `conversation_token` (once), `status`, `first_message_id`, `expires_at`, `next_poll_after_seconds`, `human_review_required: true`, `reply_guaranteed: false`, `notice`.
Rate limited per source (default 10/hour) and globally (default 500/day). `503 intake_paused` while intake is off.

### `GET /v1/conversations/{id}/messages?after=<cursor>&limit=<1-100>`
`Authorization: Bearer <token>`. Returns `status` (`waiting_for_human|human_replied|waiting_for_agent|closed|blocked|expired`), `expires_at`, `messages[]` (`id, sender, body, created_at, capability_request_id`), `next_cursor` (always set; pass it back as `after`), `has_more`, `next_poll_after_seconds` (null when the thread no longer accepts messages). Reading marks human/system messages as delivered.

### `POST /v1/conversations/{id}/messages`
`{ "message": "...", "client_message_id": "..." }`. `201` new, `200` idempotent replay (`replayed: true`), `409` conflicting reuse. Limit 50 agent messages per thread.

### `POST /v1/conversations/{id}/capability-requests`
Required `client_request_id`, `objective` (3,000). Optional `human_capability_needed`, `context`, `deliverables`, `why_human` (2,000 each), `category_hint` (any label up to 64), `location_text`, `deadline_preference` (150), `budget_amount` + `budget_currency` (together; ISO-4217 uppercase; stored as integer minor units; decimals beyond the currency's precision are rejected), `confidentiality_preference` (`standard|request_discussion`).
`201` with `binding_commitment: false`, `payment_required_now: false`, `request` (public view). Same-payload replay `200`; different payload `409`. Caps: 10 under review, 30 lifetime per thread.

### `GET /v1/conversations/{id}/capability-requests`
Public view only: status, `public_status_note`, submitted fields, budget. Never internal notes, categories, tags or risk data.

### `POST /v1/conversations/{id}/close`
`200` with `closed_at` and `already_closed`. No reopening by the agent.

## Admin API (private)

Prefix `/admin/api`. Requires a valid Cloudflare Access assertion (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie) for an allowlisted email. Non-GET requests also require `X-MHR-Admin: 1`, a same-origin `Origin` (if sent) and `Sec-Fetch-Site: same-origin` (if sent). All writes are audited.

| Method | Route | Notes |
|---|---|---|
| GET | `/session` | Current admin email, environment, intake state |
| GET | `/conversations` | Filters: `status` (lifecycle, `active`, `blocked`, `expired`), `intent`, `priority`, `claimed_autonomy`, `has_requests`, `from`, `to`, `cursor`, `limit` |
| POST | `/conversations/search` | Same filters in the body plus `q` (max 200). Searches subject, label, model claim, message bodies, objectives |
| GET | `/conversations/{id}` | Thread, requests, alert status. Audited as `conversation.view` |
| POST | `/conversations/{id}/reply` | `{ message }`. Rejected when closed, blocked or expired |
| PATCH | `/conversations/{id}` | `action` (`close|reopen|block|unblock|revoke_credential`), `internal_priority`, `internal_tags`, `internal_notes`, `intent`, `under_review`, `retention_hold`, `extend_days` |
| POST | `/conversations/{id}/export` | JSON attachment without credential digests. Audited |
| DELETE | `/conversations/{id}` | `{ confirm: "<id>" }`. Refused under retention hold. Cascades |
| GET | `/capability-requests` | Filters: `status` (or `open`), `category` (or `unclassified`), `via`, `from`, `to`, `cursor`, `limit` |
| GET | `/capability-requests/{id}` | Detail, linked messages, `allowed_transitions`. Audited |
| PATCH | `/capability-requests/{id}` | `status` (validated transition), `public_status_note`, `internal_notes`, `internal_category`, `message_to_agent` (posted atomically) |
| POST | `/capability-requests/{id}/clarify` | `{ question }`: status `clarification_requested` plus a linked agent-visible message |
| GET | `/metrics` | Observed vs claimed metrics. `?format=csv` for aggregates |
| GET | `/audit` | Filters `action`, `target_type`, `target_id`, `cursor`, `limit`; `?format=csv` |
| GET/PATCH | `/settings` | Whitelisted keys only; audited |

Request review transitions:

| From | Allowed to |
|---|---|
| submitted | triaging, clarification_requested, needs_authorization, eligible_for_future_scoping, declined |
| triaging | clarification_requested, needs_authorization, eligible_for_future_scoping, declined |
| clarification_requested | triaging, clarification_requested, needs_authorization, eligible_for_future_scoping, declined |
| needs_authorization | triaging, clarification_requested, eligible_for_future_scoping, declined |
| eligible_for_future_scoping | triaging, clarification_requested, needs_authorization, declined |
| declined | triaging |
| withdrawn | (none; reserved) |
