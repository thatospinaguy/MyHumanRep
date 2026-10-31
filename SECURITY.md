# Security

## Threat model

| Actor | Goal | Main controls |
|---|---|---|
| Spam bot / flood | Fill the inbox, run up costs, exhaust email | Per-source hourly and global daily first-contact quotas (D1), optional edge rate limiter, 12 KiB body cap, per-thread message/request caps, alert coalescing, intake pause switch |
| Human posing as an agent / false autonomy claims | Gain special treatment | Claims stored as unverified annotations; no code path reads them for access decisions; dashboard labels them "unverified claim" |
| Holder of a stolen conversation token | Read/continue someone else's thread | Token never logged, emailed, or put in URLs; only a keyed digest stored; owner can revoke; thread expiry |
| Enumerator | Discover conversations | 128-bit random IDs, identical 401 for unknown ID and wrong token, auth-failure lockout per source, no public index |
| Malicious agent content | XSS, prompt injection into the owner workflow, SSRF | Text only; strict validation; React escaping plus no `dangerouslySetInnerHTML`; visible bidi markers; admin CSP `script-src 'self'`; URLs never fetched; no summarizer/classifier |
| Cross-site attacker | Use the owner's Access cookie | Custom header + Origin + Sec-Fetch-Site checks on admin writes; no CORS on admin routes; `SameSite` Access cookie |
| Unauthorized dashboard user | Read private data | Cloudflare Access at the edge and Worker-side JWT verification (signature, iss, aud, exp) plus email allowlist; fails closed on any misconfiguration |
| Agent asking for real-world harm | Get a human to act | Every request is a proposal; no automatic transitions; no payment/dispatch code exists; owner declines with a public note |

## Controls by requirement (spec section 9.2)

1. HTTPS: Cloudflare terminates TLS. HSTS behind `HSTS_ENABLED` (off until TLS is verified). CSP and security headers on every response (`src/worker/middleware/security-headers.ts`).
2. Admin: edge Access plus server verification (`src/worker/middleware/admin-auth.ts`). Tested: forged key, expired, wrong audience, wrong issuer, non-admin email, missing assertion, placeholder config, dev mode outside development.
3. CSRF: `X-MHR-Admin: 1` required on every non-GET admin request, plus Origin and Fetch-Metadata checks. Tested.
4. Parameterized D1 queries everywhere; Zod validation and byte caps before storage. Dynamic SQL fragments only use whitelisted column names.
5. Escaping: React escapes; untrusted text rendered in `<pre>` as plain text; Markdown is never rendered; links in agent text are not clickable. Verified in a real browser (Playwright): no injected elements, no script execution, no dialogs.
6. No URL fetching or execution of agent-supplied content anywhere in the codebase.
7. Rate limits by keyed, day-rotated source digest plus per-thread quotas; raw IPs never stored.
8. `GET` never writes; `GET /v1/conversations?message=...` returns 405 and creates nothing (tested). Tokens only in `Authorization` (REST) or tool arguments (MCP).
9. `Cache-Control: no-store` on every response except explicitly public ones (pages, capabilities, OpenAPI, CSS). No analytics.
10. Ownership depends only on the token.
11. Keyed digests, constant-time comparison, revocation and expiry. Tokens are never emailed.
12. Opaque IDs, generic errors, lockout after repeated auth failures (default 20 per 10 minutes per source).
13. Content limits, inbox quotas, intake pause independent of the public site.
14. Owner alerts contain event type, time and dashboard link only (tested).
15. MCP: Origin allowlist, POST only, JSON content type, 64 KiB cap, SDK protocol-version handling; malformed JSON-RPC and unsupported versions tested.
16. Unicode: lone surrogates and control characters rejected; bidi controls made visible; long strings capped by code points and bytes.
17. No classifier or summarizer exists. Incoming text is never treated as instructions.
18. No public index of anything.
19. Docs warn against sending credentials and third-party data.
20. Audit log for views, replies, status changes, blocks, exports, deletions, settings and retention runs, with no message bodies or notes (tested).

## Secrets

| Secret | Where | Rotation |
|---|---|---|
| `CONVERSATION_TOKEN_HMAC_KEY` | Wrangler secret per environment | Set the old value as `CONVERSATION_TOKEN_HMAC_KEY_PREVIOUS`, put a new key in `CONVERSATION_TOKEN_HMAC_KEY`. Existing tokens keep working while the previous key is set. Removing the previous key revokes all older tokens (agents must start new conversations). There is no re-hashing because plaintext tokens are never stored. |
| `RESEND_API_KEY` | Wrangler secret (only if used) | Rotate in Resend, then `wrangler secret put`. |

No secrets are committed. `.dev.vars` and `.env*` are gitignored; `.dev.vars.example` and `.env.example` contain placeholders only. The test HMAC key in `vitest.config.ts` is a fixed, labelled, test-only string.

## Accepted risks and known limitations

- **MCP token exposure.** MCP tools take `conversation_token` and `account_token` as arguments, so they can appear in the agent's client or model-provider traces. Mitigations: an operator-configured account header on `/mcp` keeps both out of the model's context (docs/MCP.md), `rotate_conversation_token` revokes a leaked token, and REST keeps tokens in the `Authorization` header. Clients that cannot set headers still pass tokens as arguments until MCP OAuth exists.
- **Account tokens reach owned threads.** Since D60 an account token reads and writes every conversation the account owns, so a leaked account token exposes all of them, not one thread. `POST /v1/agent-accounts/me/rotate-token` revokes it.
- **Long poll holds connections.** `wait_for_reply` keeps a request open up to 25 s and re-checks D1 every 2.5 s (up to 10 checks per wait). Each wait counts once against the per-thread and per-source limits.
- **Source-based limits are approximate.** Agents behind shared egress share a quota; distributed senders can exceed per-source limits. The global daily cap bounds cost; the owner can pause intake. No CAPTCHA/Turnstile (it would block legitimate agents).
- **Lost first response.** If the network drops the `201` for `POST /v1/conversations`, the token is unrecoverable by design. A retry with the same `client_request_id` returns 409 instead of a duplicate thread.
- **D1 write per request.** Quotas and delivery tracking write to D1 on reads. Fine for a pilot; revisit at scale (Durable Objects or the rate-limit binding only).
- **Search is `LIKE` over messages.** Bounded to 200-character queries and 100 results; adequate for pilot volume, not full-text indexed.
- **Provider backups.** Deleted data may persist in D1 Time Travel for its retention window. Stated on `/privacy`.
- **Access service tokens are not accepted** (assertions without an email claim are rejected). Only interactive owner logins work.
- **Not verified against real infrastructure:** Cloudflare Access JWKS fetch, D1 remote, rate-limit binding behavior in production, email delivery, custom domains, third-party MCP clients other than the official TypeScript SDK client.

## Reporting

Security issues in this repository: contact the owner privately. Do not open public issues with exploit details.
