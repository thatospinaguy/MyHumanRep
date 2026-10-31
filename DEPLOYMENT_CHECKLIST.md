# Cloudflare deployment checklist

Staging and production were deployed on 2026-10-31 by following this checklist; see `docs/IMPLEMENTATION_STATUS.md` for what ran and the results. Every step below that touches Cloudflare, DNS, email or the MCP Registry needs the owner's account and explicit approval. Steps marked **APPROVAL** incur cost, change live infrastructure or make the service public.

Commands assume the repo root, `npm ci` done, and Wrangler 4.156 (pinned in `package.json`).

## 0. Prerequisites (owner)

- [ ] Cloudflare account with Workers and D1 enabled. Workers Free covers a pilot; check current D1 and Workers limits/pricing before launch.
- [ ] `myhumanrep.com` (and `myhumanrep.ca`) registered and added as Cloudflare zones, or decide to use a `*.workers.dev` hostname for staging.
- [ ] Cloudflare Zero Trust organization (free tier supports small teams) for Access.
- [ ] Decide on the email provider for owner alerts (see step 6). Optional for launch: the dashboard works without email.

```bash
npx wrangler login
```

```bash
npx wrangler whoami
```

## 1. Create D1 databases

```bash
npx wrangler d1 create myhumanrep-agent-contact-staging
```

```bash
npx wrangler d1 create myhumanrep-agent-contact
```

Copy each printed `database_id` into `wrangler.jsonc`:

- `env.staging.d1_databases[0].database_id` (replace `REPLACE_WITH_STAGING_D1_DATABASE_ID`)
- `env.production.d1_databases[0].database_id` (replace `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID`)

Do not guess IDs. The top-level (development) database id `00000000-...` is only used locally.

## 2. Apply migrations

```bash
npm run db:migrate:staging
```

```bash
npm run db:migrate:production
```

Verify:

```bash
npx wrangler d1 execute MHR_DB --remote --env staging --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected tables: `abuse_events, admin_audit, agent_accounts, agent_personas, agent_self_reports, candidate_capabilities, capabilities, capability_aliases, capability_requests, conversation_account_links, conversations, d1_migrations, embassy_inquiries, messages, notification_outbox, persona_grants, persona_inquiries, persona_revisions, project_conversations, projects, proposal_events, proposal_revisions, proposals, rate_limit_counters, settings` plus `agent_human_relationships`.

Migrations `0003`-`0008` (master spec) have never run against a remote database. Take a D1 Time Travel bookmark before applying them. `0003` rebuilds `notification_outbox` only; every other change is additive. Then confirm `SELECT COUNT(*) FROM capabilities` returns 20.

## 3. Secrets

Generate a distinct key per environment and never reuse it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
npx wrangler secret put CONVERSATION_TOKEN_HMAC_KEY --env staging
```

```bash
npx wrangler secret put CONVERSATION_TOKEN_HMAC_KEY --env production
```

Store a copy in your password manager. Losing it invalidates every conversation credential (agents would have to start new conversations). Without it, `POST /v1/conversations` and all thread operations return `503 service_not_configured`.

## 4. Cloudflare Access for `/admin`

In the Cloudflare Zero Trust dashboard, Access, Applications, add a **self-hosted** application per environment:

- [ ] Application domain: your host with path `admin` and a second entry with path `admin/*` (both `/admin` and everything below it).
- [ ] Policy: Allow, include your email address only.
- [ ] Copy the **Application Audience (AUD) tag**.
- [ ] Note your team domain: `https://<team>.cloudflareaccess.com`.

Then set in `wrangler.jsonc` for that environment:

- `ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`
- `ACCESS_AUD`: the AUD tag
- `ADMIN_EMAILS`: your email (comma-separate if more than one)

To keep the email out of the repo, omit `ADMIN_EMAILS` from `vars` and set it as a secret instead (staging does this). A secret cannot share a name with a deployed var, so deploy without the var first, then:

```bash
npx wrangler secret put ADMIN_EMAILS --env staging
```

The Worker independently verifies the `Cf-Access-Jwt-Assertion` signature (team JWKS), issuer, audience and expiry, then checks the email allowlist. Any placeholder or missing value makes `/admin` return 503/403. It never defaults open.

If staging runs on `*.workers.dev`, enable Cloudflare Access for that hostname as well, or use a custom staging hostname such as `staging.myhumanrep.com` (preferred; requires a DNS record).

## 5. Hostnames

Edit `wrangler.jsonc`:

- [ ] `env.staging.vars.PUBLIC_BASE_URL`: the real staging origin.
- [ ] `env.production.vars.PUBLIC_BASE_URL`: `https://myhumanrep.com` (already set).
- [ ] Add a custom-domain route **(APPROVAL: DNS change)**. For production, add under `env.production`:

```jsonc
"routes": [
  { "pattern": "myhumanrep.com", "custom_domain": true }
]
```

Optionally also `www.myhumanrep.com`, `myhumanrep.ca`, `www.myhumanrep.ca` as custom domains on the same Worker. They are listed in `ALIAS_HOSTS`, so the Worker 301-redirects safe GETs to `https://myhumanrep.com`, strips query strings on private paths, and rejects non-GET requests with `400 non_canonical_host`. Alternative: a zone-level Redirect Rule on `myhumanrep.ca`.

## 6. Owner email alerts (optional) **(APPROVAL: enabling real email)**

Default is `NOTIFY_PROVIDER=none`: alerts are recorded as `disabled` and the dashboard is the source of truth.

Option A, Cloudflare Email (no third party): enable Email Routing on the zone, verify your destination address, then in `env.production`:

```jsonc
"send_email": [{ "name": "SEND_EMAIL", "destination_address": "you@example.com" }]
```

and set vars `NOTIFY_PROVIDER=cloudflare_email`, `NOTIFY_TO=you@example.com`, `NOTIFY_FROM=alerts@myhumanrep.com` (an address on the zone).

Production does this without `destination_address` (the binding can still only reach verified Email Routing destinations) and with `NOTIFY_TO` as a Worker secret, so the owner address stays out of the repo. Enabling Email Routing replaces any existing MX and SPF records on the zone.

Option B, Resend: verify the sending domain in Resend, set `NOTIFY_PROVIDER=resend`, `NOTIFY_TO`, `NOTIFY_FROM`, and:

```bash
npx wrangler secret put RESEND_API_KEY --env production
```

Neither provider path has been exercised against the real service. Verify with a test inquiry on staging; failed sends show in the dashboard Overview ("owner alerts failed") and in the conversation's "Owner alerts" panel.

## 7. Deploy staging

```bash
npm run check
```

```bash
npm run deploy:staging
```

Smoke test (intake is closed by default; open it in `/admin/settings` first, or expect 503 on first contact):

```bash
BASE_URL=https://YOUR_STAGING_HOST node scripts/verify-openapi.ts
```

```bash
BASE_URL=https://YOUR_STAGING_HOST node scripts/smoke-rest.ts --wait
```

Reply from `https://YOUR_STAGING_HOST/admin/` while it waits.

```bash
BASE_URL=https://YOUR_STAGING_HOST node scripts/smoke-mcp.ts modern
```

```bash
BASE_URL=https://YOUR_STAGING_HOST node scripts/smoke-mcp.ts legacy
```

Then confirm by hand:

- [ ] `/admin/` redirects to the Access login when signed out; signed in, the dashboard loads.
- [ ] A request to `/admin/api/conversations` without Access returns 401/403.
- [ ] Cron: within 5 minutes, alerts move from `pending` (check `wrangler tail --env staging` for `outbox_drain`).
- [ ] Add the endpoint to a real MCP client (for example Claude Desktop/Code with `{"type": "http", "url": "https://YOUR_STAGING_HOST/mcp"}`) and run the flow. Not yet verified with third-party clients.

## 8. Deploy production **(APPROVAL)**

```bash
npm run deploy:production
```

Production starts with `INTAKE_ENABLED=false`. Turning on public intake is a separate owner decision in `/admin/settings` **(APPROVAL)**.

```bash
BASE_URL=https://myhumanrep.com node scripts/verify-openapi.ts
```

Verify on the real host: `GET /`, `/for-agents`, `/v1/capabilities`, `/openapi.json`, and `POST /mcp` (smoke-mcp).

## 9. HSTS

After TLS on every hostname is verified, set `HSTS_ENABLED=true` in `env.production.vars` and redeploy. Only then consider HSTS preload.

## 10. MCP Registry **(APPROVAL)**

See [REGISTRY_PUBLISHING.md](REGISTRY_PUBLISHING.md). Only after production is live and verified.

## Rollback and recovery

- Code: `npx wrangler deployments list --env production`, then `npx wrangler rollback --env production` (previous version).
- Pause intake without a deploy: `/admin/settings`, uncheck "Accept new inquiries".
- Data: D1 Time Travel can restore a database to a point in time within its retention window: `npx wrangler d1 time-travel info myhumanrep-agent-contact` and `npx wrangler d1 time-travel restore myhumanrep-agent-contact --timestamp=<ISO>`. Restoring also restores data deleted by retention, so record why.
- Migrations are additive. Never edit an applied migration; add a new one.
