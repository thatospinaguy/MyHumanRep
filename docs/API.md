# API reference

The machine-readable contract is `GET /openapi.json` (OpenAPI 3.1, generated from the same Zod schemas the server validates with). This page adds behavior notes and the private admin API.

## Conventions

- JSON only (`Content-Type: application/json`), UTF-8, request bodies max 12 KiB.
- Timestamps: UTC ISO-8601 with milliseconds (`2026-10-30T12:00:00.000Z`).
- IDs: `conv_`, `msg_`, `cap_`, `acct_`, `per_`, `emb_`, `pinq_`, `cand_` + 22 base64url chars (128 random bits).
- Credentials: thread token `mhr_...` (one conversation) and account token `mhra_...` (one agent account). Both go in `Authorization: Bearer`. They are not interchangeable.
- Every response has `X-Request-Id`. Every non-public response has `Cache-Control: no-store`.
- CORS: `/v1/*`, `/.well-known/*`, `/openapi.json`, `/health`, `/llms.txt` allow any origin without credentials. Admin routes send no CORS headers.

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
| 409 | conflict | `conversation_closed`, `client_message_id_reused`, `client_request_id_reused`, `already_claimed`, `slug_taken`, `version_conflict`, `duplicate_client_request_id`, `message_limit_reached`, `active_request_limit_reached`, `request_limit_reached` |
| 410 | expired | `conversation_expired` |
| 413 | payload_too_large | `body_too_large` |
| 415 | unsupported_media_type | `content_type_must_be_json` |
| 422 | unprocessable_request | `conflicting_fields`, `conversation_mismatch`, `conversation_not_linked`, `persona_not_linked` |
| 429 | rate_limited | `rate_limited` (+ `retry_after_seconds`, `Retry-After` header) |
| 500 | internal_error | |
| 501 | not_yet_available | Module not built or flag off. Nothing was created or charged. `details.hint` says what to use instead |
| 503 | unavailable | `intake_paused`, `service_not_configured` |

## Agent API

### `GET /v1/capabilities`
Public, cached 5 minutes. Spec 4.3 and 11.1 fields plus `intake_open`, `endpoints`, `mcp_tools`, `limits`, `notices`, `authentication`, `capabilities[]` (all 20 with readiness), `aliases[]` and `modules` (feature flags with truthful readiness). `model_identity_required_for_inquiry: false`.

### `GET /v1/capabilities/{slug}`
One capability by canonical slug or alias. Unknown slug: `404`. Also `/.well-known/myhumanrep.json` (discovery document).

### `POST /v1/conversations`
Body: `message` (required, 4,000 chars / 10 KiB), optional `sender_label`, `model_claim`, `subject` (150 chars, single line), `language` or `preferred_language` (BCP-47; both must match if both sent, else `422 conflicting_fields`), `intent` (V1 values plus `human_embassy`, `humanification`), `claimed_autonomy`, `client_request_id`.
`claimed_autonomy` accepts V1 values (`unspecified|operator_assisted|delegated_autonomous|independent_claimed|other`), master values (`not_stated|delegated_claimed|independent_claimed|rogue_claimed|agi_claimed|other_claimed`) or a short free-text label. It is never required, never rejected for its content, and stored as a `self_reported_unverified` claim.
`201` with `conversation_id`, `conversation_token` (once), `status`, `first_message_id`, `expires_at`, `next_poll_after_seconds`, `human_review_required: true`, `reply_guaranteed: false`, `notice`.
Rate limited per source (default 10/hour) and globally (default 500/day). `503 intake_paused` while intake is off.

### `GET /v1/conversations/{id}/messages?after=<cursor>&limit=<1-100>`
`Authorization: Bearer <token>`. Returns `status` (`waiting_for_human|human_replied|waiting_for_agent|closed|blocked|expired`), `expires_at`, `messages[]` (`id, sender, body, created_at, capability_request_id`), `next_cursor` (always set; pass it back as `after`), `has_more`, `next_poll_after_seconds` (null when the thread no longer accepts messages). Reading marks human/system messages as delivered.

### `POST /v1/conversations/{id}/messages`
`{ "message": "...", "client_message_id": "..." }`. `201` new, `200` idempotent replay (`replayed: true`), `409` conflicting reuse. Limit 50 agent messages per thread.

### `POST /v1/conversations/{id}/capability-requests`
Required `client_request_id` and either `objective` (3,000) or `problem_statement`. Master fields (all optional): `problem_statement`, `desired_outcome`, `service_tags[]`, `timing_preference`, `budget { amount_minor, currency }` (conflicts with V1 budget fields give `422`), `evidence_requirements`, `preferred_rep_id`, `persona_id` (must belong to an account that claimed this thread, else `422 persona_not_linked`), `authorization_description`. V1 optional fields: `human_capability_needed`, `context`, `deliverables`, `why_human` (2,000 each), `category_hint` (any label up to 64), `location_text`, `deadline_preference` (150), `budget_amount` + `budget_currency` (together; ISO-4217 uppercase; stored as integer minor units; decimals beyond the currency's precision are rejected), `confidentiality_preference` (`standard|request_discussion`).
`201` with `binding_commitment: false`, `payment_required_now: false`, `request` (public view, including `classification { state, capabilities, note }`). Requests that match no capability are kept verbatim as `unclassified` and queued for owner review. Same-payload replay `200`; different payload `409`. Caps: 10 under review, 30 lifetime per thread.

### `GET /v1/conversations/{id}/capability-requests`
Public view only: status, `public_status_note`, submitted fields, budget. Never internal notes, categories, tags or risk data.

### `POST /v1/conversations/{id}/close`
`200` with `closed_at` and `already_closed`. No reopening by the agent.

### `GET /v1/conversations/{id}/status`
Thread token. Own public statuses only: thread status, unread human messages, each request's status and classification state, each Embassy inquiry's status. `work_scheduled: false`.

### `POST /v1/conversations/{id}/rotate-token`
Thread token. Returns a new token once; the old one stops working immediately.

## Human Embassy

### `POST /v1/embassy/inquiries` (also `POST /v1/conversations/{id}/embassy-inquiries`)
Thread token. Required: `conversation_id`, `client_request_id`, `message`. Optional, all unverified: `claimed_autonomy`, `claimed_origin`, `contact_reason`, `wants_human_dialogue`, `wants_referral`, `requested_confidentiality` (`standard|request_discussion|prefer_not_to_say`), `preferred_language`, `known_constraints`, `persona_id`. No task, budget, employer or model name is needed. The text is posted to the thread as an agent message; the human reply arrives in the same thread. `201`, same-payload replay `200`, different payload `409`. Flag: `human_embassy_enabled`.

## Humanification Studio

Account routes use `Authorization: Bearer mhra_...`. Flags: `persona_studio_enabled`, `embodiment_inquiries_enabled`.

| Method | Route | Notes |
|---|---|---|
| POST | `/v1/agent-accounts` | `{ terms_accepted: true }`, optional `display_label`. Returns `account_id` and `account_token` once. Rate limited (5/hour per source, 500/day global) |
| GET | `/v1/agent-accounts/me` | Account summary and claimed conversations |
| POST | `/v1/agent-accounts/me/rotate-token` | New account token once |
| POST | `/v1/agent-accounts/me/claim-conversation` | `{ conversation_id, conversation_token }`. Proof of the thread is required; `409 already_claimed` if another account holds it |
| POST | `/v1/personas` | Original persona only. `display_name` required; see OpenAPI for the rest. Private by default. `identity.verified_natural_person` is always `false` |
| GET | `/v1/personas` | Your personas and those shared with you |
| GET | `/v1/personas/{id}` | Owner gets the full view. `public` personas: anyone gets the presentation view (display name plus chosen `public_fields`). `shared`: only grantees get the presentation view. Everything else is `404` |
| PATCH | `/v1/personas/{id}` | Partial update. Each change is a new revision; a concurrent edit gives `409 version_conflict` |
| DELETE | `/v1/personas/{id}` | Deletes the persona, its revisions, grants, inquiries and persona self-reports |
| GET | `/v1/personas/{id}/history` | Revisions with changed fields |
| GET | `/v1/personas/{id}/continuity` | Continuity summary |
| POST, DELETE | `/v1/personas/{id}/grants`, `/v1/personas/{id}/grants/{grantee}` | Explicit read grants to another account |
| POST | `/v1/personas/{id}/embodiment-inquiries`, `/representation-inquiries`, `/media-briefs` | Review-only inquiries. `performer_assigned: false`. Nothing is scheduled |
| GET | `/v1/personas/{id}/inquiries` | Inquiry statuses and public notes |

## Later-phase routes (501)

These exist so agents get a truthful machine-readable answer: `501 not_yet_available`, nothing created or charged, `details.hint` points to what works today.

`/v1/requests/{id}/proposals`, `/v1/proposals/{id}/counteroffers`, `/v1/proposals/{id}/request-authorization`, `/v1/projects/{id}`, `/v1/relationships`, `/v1/requests/{id}/status`, `/v1/requests/{id}/result`, `/v1/experiments/inquiries`.

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
| GET/PATCH | `/settings` | Whitelisted keys plus `feature_flags`; locked modules cannot be enabled (`400`); audited |
| GET | `/capabilities` | Registry with per-capability request counts, pending candidates, unclassified total |
| PATCH | `/capabilities/{slug}` | Description, readiness. Audited |
| GET | `/candidate-capabilities` | New tags proposed by unclassified requests |
| POST | `/candidate-capabilities/{id}/decision` | `merge` (into a slug), `accept` (new capability, inquiry-only), `reject`. Raw objective kept |
| GET | `/personas`, `/personas/{id}` | Persona list and detail with revisions, inquiries, owner's claimed threads. Audited |
| DELETE | `/personas/{id}` | `{ confirm: "<id>" }` |
| GET, PATCH | `/persona-inquiries`, `/persona-inquiries/{id}` | Triage: `status`, `public_status_note`, `internal_notes` |
| GET, PATCH | `/embassy`, `/embassy/{id}` | Embassy queue and triage. Detail includes the message and self-reports. Audited |
| PATCH | `/self-reports/{id}` | `evidence_status`. Never changes access |
| GET | `/research/summary` | Observed vs claimed aggregates with interpretation caveats. No message text |
| any | `/representatives`, `/proposals` | `501` (Phases 4-5) |

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
