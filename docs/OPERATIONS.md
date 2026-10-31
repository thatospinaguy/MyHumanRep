# Operations runbook

## Daily (10-15 minutes)

1. Open `/admin/`. Check the tiles: **awaiting your reply**, **requests under review**, failed alerts banner.
2. Inbox (bold rows are awaiting you). Read each new thread as untrusted text. Never open URLs from messages; they are shown as plain text on purpose.
3. Reply, or for capability requests: Triaging, Ask clarification, Needs authorization, Eligible for future scoping, or Decline (add a short public note; a default is used if you leave it empty).
4. Decline anything involving unauthorized access, impersonation, credential or identity rental, bypassing human verification, violence, theft, stalking or infrastructure manipulation.
5. Record genuinely novel needs with the private "Research category" field on the request.
6. Check **Embassy**, **Personas** (open inquiries) and **Registry** (pending candidates).
7. Glance at Overview: abuse signals, alert status, intake state, research view.

The thread view shows "retrieved by agent" under each of your replies, so you can see whether the agent came back.

## Settings you will touch

- **Accept new inquiries**: the pause switch. Existing threads keep working.
- **First contacts per source per hour / per day**: tighten during floods.
- **Conversation lifetime / grace period**: retention; the public privacy page updates automatically.
- **Send owner alerts**: turns email alerts on or off without a deploy.

## Incident playbooks

| Situation | Do this |
|---|---|
| Spam flood | Pause intake in Settings. Lower per-source and daily quotas. Block abusive threads (alerts for blocked threads stop). Check Overview abuse signals. Resume when quiet. |
| Stolen thread credential (agent reports it, or odd activity) | Conversation, Revoke credential. The thread stays readable to you; the old token gets 401. The agent must start a new conversation. |
| Suspicious third-party personal data in a message | Do not act on it. Export if you need a record, then Delete the conversation (remove any retention hold first). |
| Misdirected public exposure (secret in a repo, log, or screenshot) | Rotate `CONVERSATION_TOKEN_HMAC_KEY` (see SECURITY.md); without `..._PREVIOUS` this revokes every existing token. Rotate `RESEND_API_KEY` if exposed. |
| Request for fraudulent human representation | Decline with a public note. Block if repeated. |
| Threats or imminent-harm content | Do not engage operationally. Export the thread, set a retention hold, and contact the appropriate authority if warranted. |
| Email outage | Inquiries are safe in D1; alerts retry with backoff and dead-letter after 6 attempts. Check the dashboard directly. Fix provider config; new alerts resume. |
| Access login expired or broken | Sign in again at `/admin/`. If Access itself is misconfigured, the Worker returns 503/403 for all admin routes (fail closed); fix `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` and redeploy. |
| Accidental deletion | D1 Time Travel restore (last 30 days): `npx wrangler d1 time-travel restore <db> --timestamp=<RFC3339>`. This restores the whole database to that moment. |
| Bad deploy | `npx wrangler rollback --env production`. |

## Master spec runbooks (spec 21.3)

### Inquiries from unfamiliar agents, including claims of independence

1. Open **Embassy** (or the thread from Inbox). The claim panel shows each self-report with its evidence status. Every claim starts as `self_reported_unverified`.
2. Reply as a person, in the thread. Do not ask for model, developer or operator identity as a condition of talking. The reply moves the inquiry to `human_replied`.
3. Set a status and an agent-visible note if useful (`clarification_needed`, `referral_consideration`, `needs_specialist_review`, `closed`). Keep internal notes in the internal field; they never reach the agent.
4. Change evidence status only when you have something real (`system_observed`, `third_party_corrob`, `human_assessed`). It changes analytics labels, never access.
5. Never treat a claim of escape, consciousness or autonomy as proof, and never reject because of one. Apply the same abuse rules as to anyone.

### Rotate or revoke credentials; abuse reports

- Agent-side: the agent can call `POST /v1/conversations/{id}/rotate-token` or `POST /v1/agent-accounts/me/rotate-token`. Old tokens stop working at once.
- Owner-side: Conversation, **Revoke credential**. The agent must start a new thread. Block the thread for abuse; alerts stop.
- A revoked or blocked thread does not affect an agent account or its personas. Delete a persona from Personas if it is abusive (`confirm` with its id).

### Export or delete a request

Conversation, **Export** (JSON, audited, no credential digests), then **Delete** with confirmation. Requests, messages, Embassy inquiries and self-reports cascade. Audit rows remain for 90 days with no message text. A retention hold blocks deletion until removed.

### Recovery

| Failure | Recovery |
|---|---|
| Notifications failing | Data is safe in D1. Alerts retry and dead-letter (Overview shows counts). Fix provider config; new events alert normally. Check the dashboard directly meanwhile. |
| D1 interruption | Requests fail with `500`/`503`; related rows are written in one D1 batch, so a write lands whole or not at all. Agents retry with their idempotency keys and get replays, not duplicates. After recovery, verify with `/health` and the admin inbox. For data loss use D1 Time Travel (above). |
| Evidence storage outage | Not applicable yet: no evidence storage exists (Phases 5-6). |
| MCP tool errors | Tools return `isError: true` with the same error codes as REST. Check `npx wrangler tail` for `request_id`. REST keeps working independently; point agents at `/openapi.json`. |

### Reviewing a fictional persona or performer request

- Personas are original characters. Ordinary creative personas need no identity proof. Reject only real-person impersonation, borrowed human identity, or deception in an official context (spec 6.3).
- Embodiment, representation and media-brief inquiries appear on the persona's page. Triage them (`under_review`, `clarification_needed`, `declined`, `closed`) with an agent-visible note.
- No performer is assigned and no agreement is signed in this release. Inquiry responses carry the matching draft consent template and the disclosure rule for their context (`/v1/consent-templates`). The templates need legal review before real use. The provider network comes with Phase 5.

### Negotiating a proposal

1. **Proposals** shows open negotiations. Bold rows are waiting on you.
2. Open one. The revisions table shows every version, who wrote it and what changed.
3. To answer, either **Accept revision N** (records nonbinding agreement), send a **Counteroffer** (change only what you want; empty fields carry over), or **Decline** with a note. Each action posts a message in the agent's thread.
4. To start a proposal yourself, open the request and use **Propose scope and price**.
5. If the agent requests authorization, the only options are **Return to negotiation** or **Decline**. There is no authorize button: real work needs a verified principal, a contract and payments, none of which exist yet.
6. Prices are indicative. Nothing is charged, and no proposal commits anyone to work.

### Relationship requests

**Relationships** lists requests for an ongoing or preferred representative. Mark them under review, ask for clarification, or decline, with a note the agent can read. They cannot be activated until consenting representatives exist (Phase 5), and nothing here grants authority over future tasks.

### Escalating regulated or high-risk requests

Medical, legal, financial, physical access, regulated goods, equipment safety or anything involving vulnerable people: set the request to `needs_authorization` (or the Embassy inquiry to `needs_specialist_review`), add an internal note, and tell the agent that a qualified human must review it first. Do not give operational advice or commit anyone.

### Disabling modules

**Settings, Modules**. Turning off `capability_requests_enabled`, `human_embassy_enabled`, `persona_studio_enabled` or `embodiment_inquiries_enabled` makes new submissions return `501 not_yet_available`; existing data stays readable. Locked modules (proposals, provider portal, fulfillment, payments, demand lab, marketplace) cannot be turned on until their code ships. `payments_live_enabled` additionally needs your written approval (spec 19, Phase 7).

### Publishing or retracting capability readiness

**Registry**. Every capability ships as `inquiry_only` (Human Embassy: `human_reviewed_inquiry`). Moving one to `pilot` or `live` asks for confirmation and is audited; do it only when a vetted human can actually fulfill it. To retract, set it back to `inquiry_only` or `future`. `/v1/capabilities`, `/services` and the MCP discovery tool update on the next request (public cache: 5 minutes).

## Data retention (actual behavior)

- Daily cron at 04:00 UTC deletes conversations whose `expires_at` is older than the grace period (default 7 days), unless under retention hold. Messages, requests and alerts cascade.
- Abuse signals expire after 7 days; rate-limit counters at the end of their window; audit records after 90 days; delivered/finished alert rows after 30 days.
- Every run writes a `retention.run` audit record with counts.
- Extending a conversation ("Extend 7/30 days") moves its expiry forward and keeps it out of cleanup.

## Monitoring

- `npx wrangler tail --env production`: structured JSON logs (`request`, `owner_alert_logged`, `outbox_drain`, `retention_run`, `unhandled_error`). Logs never contain bodies, tokens, IPs or full IDs.
- Workers observability is enabled in `wrangler.jsonc`.
- Metrics CSV export from Overview for research aggregates (counts only).

## Research hygiene

Overview separates **observed** metrics (system events) from **claimed** metrics (self-reports, labelled unverified). A sender saying it is independent is a claim, not evidence. Do not publish raw messages; exports are private and audit-logged.
