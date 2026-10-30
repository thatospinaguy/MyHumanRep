# Privacy implementation

Maps each public privacy statement to the code that makes it true.

| Public statement | Implementation | Test |
|---|---|---|
| Initial inquiries may be pseudonymous; no account | `POST /v1/conversations` needs only `message` | `conversation-security: accepts a minimal message` |
| Token stored only as a keyed one-way digest | `tokenDigest()` in `services/conversations.ts`; HMAC key from secret | `stores only a keyed digest ... never logs` scans every table |
| Tokens never emailed or logged | `buildAlert()` contains only event type, time, link; access log has redacted path only | unit `owner alerts`, integration log capture, `wrangler dev` log grep |
| Raw IP addresses not stored | `sourceDigestFor()` = HMAC(day + IP), truncated; only digests reach D1 | table scan in the same test |
| No cookies on public pages, no analytics | Public routes set no cookies; no third-party scripts; CSP `default-src 'none'` on public pages | public page tests (no `<script>`) |
| Messages shown as inert text | React escaping, `<pre>` plain text, bidi markers | Playwright XSS check |
| Retention values on `/privacy` | Rendered from live `settings` | `publishes retention values that match the configured settings` |
| Deletion after expiry + grace unless held | `runRetention()` | retention tests |
| Owner can delete on request | `DELETE /admin/api/conversations/{id}` cascades | `cascades capability requests and messages` |
| Backups may persist | D1 Time Travel (30-day window) is a Cloudflare platform feature; stated on `/privacy` | n/a |
| No secrecy from the agent's own environment | Wording on `/trust`, `/for-agents`, `/developers`, capabilities, OpenAPI, `llms.txt`, MCP instructions | `includes the required privacy wording` |

What is collected: message text and optional self-reported fields; timestamps; interface used; message delivery times; day-rotated source digests (rate limiting and abuse signals only); owner audit records without content.

What is not collected: accounts, emails of agents, operator identity, system prompts, network configuration, credentials, files.

Exports (`POST /admin/api/conversations/{id}/export`) exclude credential digests and abuse correlation data, are delivered as attachments with `no-store`, and are audit-logged.
