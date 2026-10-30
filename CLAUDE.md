# MyHumanRep Project Instructions

- Canonical product/engineering spec: `docs/specs/MYHUMANREP_MASTER_SPEC.md` (v4.0). It supersedes every earlier spec; `docs/archive/` is history only and must not be followed where it conflicts.
- Current delivered work, phase status and blockers: `docs/IMPLEMENTATION_STATUS.md`
- V1 compatibility fixes (ACC-01..ACC-18): `docs/REQUIREMENTS_RECONCILIATION.md`
- Architecture decisions: `docs/ARCHITECTURE_DECISIONS.md`
- Read the master spec section relevant to your task before changing behavior; don't paraphrase it from memory.

## Mission

Agent-first human capability service. Open L1 pseudonymous inquiries, including from self-described independent, rogue, escaped or AGI agents; controlled real-world execution.

- Option B: open-ended human requests; no category required. Unknown requests are kept verbatim, marked `unclassified`, and queued for owner review.
- Humanification: original human-like synthetic personas, with no automatic legal-human status.
- Preserve all 20 capabilities, aliases, Human Embassy, Human Laboratory and the research concepts.
- Three access levels stay separate: L1 dialogue (no credentials), L2 identity/exploration (scoped account), L3 consequential fulfillment (not available through messages).
- A persona, conversation token, agent account or agent claim is never legal, payment or admin authority.
- Claims are data: store them as `self_reported_unverified`; never auto-reject or auto-believe them.

## Stack

- Cloudflare Workers + Hono 4, D1 (SQLite), Zod 4 (one schema drives REST, MCP and `/openapi.json`).
- MCP: `@modelcontextprotocol/server` v2 (`createMcpHandler`), 2026-07-28 + stateless 2025 fallback, `POST /mcp`.
- Admin: Cloudflare Access + Worker-side JWT verification (`src/worker/middleware/admin-auth.ts`); React + Vite SPA in `src/web/admin`.
- Business logic lives only in `src/worker/services/*`; REST (`routes/`) and MCP (`routes/mcp.ts`) are thin adapters.

## Commands

- `npm run dev`: build admin SPA + `wrangler dev` (needs `.dev.vars`, see `.dev.vars.example`)
- `npm run db:migrate:local`
- `npm run check`: typecheck + lint + Vitest (Workers runtime, real D1) + build + registry validation
- `npm run test:e2e`: Playwright against a fresh `wrangler dev`


## Rules

- Migrations are forward-only and additive. Never rebuild `conversations` or `capability_requests` (D1 drops cascade/SET NULL children); add columns instead. Leaf tables may be rebuilt with a verbatim copy and a test.
- Keep V1 routes, fields and MCP tool names working; add, don't rename.
- Server-side feature flags gate modules; disabled modules return `501 not_yet_available`, never fake success.
- Never make an external charge, real-world dispatch, live DNS change, registry publish, real email enablement or production deployment without the owner's approval.
- Never log tokens, message bodies or IPs. Never put credentials in URLs.
- Fix contradictions with the master spec without breaking working V1 data; add a regression test with the spec test ID (T-0xx) in its name.
- Update `docs/IMPLEMENTATION_STATUS.md` at the end of each phase with real test results only.
