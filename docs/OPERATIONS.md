# Operations runbook

## Daily (10-15 minutes)

1. Open `/admin/`. Check the tiles: **awaiting your reply**, **requests under review**, failed alerts banner.
2. Inbox (bold rows are awaiting you). Read each new thread as untrusted text. Never open URLs from messages; they are shown as plain text on purpose.
3. Reply, or for capability requests: Triaging, Ask clarification, Needs authorization, Eligible for future scoping, or Decline (add a short public note; a default is used if you leave it empty).
4. Decline anything involving unauthorized access, impersonation, credential or identity rental, bypassing human verification, violence, theft, stalking or infrastructure manipulation.
5. Record genuinely novel needs with the private "Research category" field on the request.
6. Glance at Overview: abuse signals, alert status, intake state.

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
