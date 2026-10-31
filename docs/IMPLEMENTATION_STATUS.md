# Implementation status

Tracks delivery against `docs/specs/MYHUMANREP_MASTER_SPEC.md` (v4.0), section 19 phases and section 20 acceptance tests. Format per spec 21.2.

Status values: `Not started | In progress | Implemented | Tested | Staging deployed | Production deployed | Blocked`. "Tested" means implemented and covered by an executed automated test in this repo. Nothing is deployed anywhere from this branch.

Last full run: 2026-10-31 on branch `claude/upbeat-mayer-9ipp4n`.

- `npm run check`: typecheck, lint, Vitest 163/163 (15 files, Workers runtime, real D1), build, MCP registry schema validation. All passing.
- `npm run test:e2e`: Playwright 17/17 against a fresh `wrangler dev` (local D1), including the spec 20.7 demonstration (`tests/e2e/master-demo.spec.ts`) and the Phase 4 gate (`tests/e2e/phase4-negotiation.spec.ts`).

## Summary

| Phase | Status | Commit | Feature flags |
|---|---|---|---|
| 0 Baseline and reconciliation | Tested | `d6cad3a` | n/a |
| 1 Capability registry and Option B | Tested | `279bb21` | `capability_requests_enabled` (on) |
| 2 Humanification Studio | Tested (media uploads gated off) | `80dc362` | `persona_studio_enabled`, `embodiment_inquiries_enabled` (on); `persona_media_enabled` (locked off) |
| 3 Human Embassy | Tested | `e3a2260` | `human_embassy_enabled` (on) |
| Admin UI, OpenAPI 1.1, 20.7 demo | Tested | `c7e08c6` | n/a |
| 4 Negotiation, scoping, relationships | Tested (relationship activation and performer agreements wait for Phase 5) | `82dd493`, `186c07a`, 4c below | `nonbinding_proposals_enabled` (on) |
| 5 Invite-only provider network | Not started (admin routes return 501) | | `worker_portal_enabled` (locked off) |
| 6 Specialized services, Human Lab | Not started (inquiry-only via capability requests) | | `manual_fulfillment_enabled` (locked off) |
| 7 Payments and production fulfillment | Not started | | `payments_test_mode`, `payments_live_enabled` (locked off) |
| 8 Autonomous Demand Lab | Not started | | `autonomous_demand_lab_enabled`, `public_marketplace_enabled` (locked off) |
| Staging deployment | Not started (needs owner approval) | | |
| Production deployment | Not started (needs owner approval) | | |

Locked flags cannot be enabled through the admin API (`400`) until their module has code. Disabled modules return `501 not_yet_available`; nothing returns fake success.

## Phase 0: baseline and reconciliation

Status: **Tested** (`d6cad3a`).

- Traceability matrix ACC-01..ACC-18: [REQUIREMENTS_RECONCILIATION.md](REQUIREMENTS_RECONCILIATION.md). Contradictions confirmed by probing master-spec payloads against unmodified V1 before changing code.
- Fixed: master autonomy vocabulary (`rogue_claimed`, `agi_claimed`, free text) accepted and stored as `self_reported_unverified` claims (ACC-02); `human_embassy`/`humanification` intents (ACC-04); `preferred_language` (ACC-06); open-ended requests without `objective` via `problem_statement` (ACC-08); spec 4.2 notice text (ACC-13); discovery documents (ACC-14, ACC-16..18).
- Delivery fix: reading a page marks only that page's messages delivered.
- `llms.txt` lists the 20 canonical capabilities plus Human Embassy and Humanification entry points (it previously listed only the six V1 families). Regression test: `T-001 llms.txt ...` in `tests/integration/public.test.ts`.
- Code: `src/worker/services/self-reports.ts`, `src/worker/services/conversations.ts`, `src/worker/schemas/api.ts`, `src/worker/content.ts`, `migrations/0003_master_reconciliation.sql`.
- Tests: `tests/integration/master-accessibility.test.ts` (T-001, T-002, T-003, T-004, T-007, T-009, T-010, T-011, T-022, T-067, T-069, T-071). V1 suites still pass unchanged except where V1 asserted the contradiction itself (the old test that rejected `rogue` was inverted).
- Migration: `0003` adds columns to `conversations` (no rebuild), adds `agent_self_reports` with backfill, rebuilds the leaf table `notification_outbox` with a verbatim copy (T-071 fixture test).
- Gate: agent to human to agent workflow passes (REST, MCP, browser); no cross-thread access; admin protected. Met.

## Phase 1: capability registry and Option B

Status: **Tested** (`279bb21`).

- 20 canonical capabilities and 16 alias families in `src/worker/catalog/capabilities.ts`, seeded by generated `migrations/0004_capability_registry.sql` (`npm run gen:capabilities`). Readiness is truthful: 19 are `inquiry_only`, Human Embassy is `human_reviewed_inquiry`; `fulfillment_available` is false for all.
- Public: `GET /v1/capabilities`, `GET /v1/capabilities/{slug}`, `/services`, `/services/{slug}`, `/.well-known/myhumanrep.json`.
- Option B: unknown requests kept verbatim, `classification_state = unclassified`, candidate tags queued in `candidate_capabilities`; admin merge/accept/reject keeps the raw objective.
- MCP parity: `discover_human_capabilities`, `describe_human_need`, `get_capability_request_status` and four preset request tools.
- Tests: `tests/integration/capability-registry.test.ts` (T-006, T-007, T-025, T-026, T-027, T-028, T-029, T-059).
- Gate: all 20 available for inquiry; novel request accepted and queued; no automatic action. Met.

## Phase 2: Humanification Studio

Status: **Tested** for accounts, personas, revisions, grants, continuity and inquiries. Real avatar/voice uploads and synthesis are **Not started** (`persona_media_enabled` locked off; only text briefs are stored).

- Agent account token (`mhra_`) is separate from thread tokens (`mhr_`); different HMAC purposes, not interchangeable.
- Claiming a thread requires the account token plus that thread's token (T-038, T-039).
- Personas: original origins only, private by default, optimistic versioning, full revision history, explicit grants, continuity summary, delete removes persona self-reports.
- Embodiment, representation and media-brief inquiries are review-only: `performer_assigned: false`, no scheduling.
- Code: `src/worker/services/{agent-accounts,personas}.ts`, `src/worker/routes/humanification.ts`, `migrations/0005_humanification.sql`.
- Tests: `tests/integration/humanification.test.ts` (T-034..T-043, T-046).
- Gate: persona persists without KYC or natural-person status; another agent cannot read or change it. Met.
- Not done from spec 6: performer decline/withdraw (T-044) and scope-of-performance enforcement (T-045) need the provider network (Phase 5). Draft consent templates shipped in Phase 4.

## Phase 3: Human Embassy

Status: **Tested** (`e3a2260`).

- `POST /v1/embassy/inquiries` and `POST /v1/conversations/{id}/embassy-inquiries`; only `message` required. Self-reports optional, stored unverified.
- `GET /v1/conversations/{id}/status`, `POST /v1/conversations/{id}/rotate-token`.
- Admin reply moves open inquiries to `human_replied`. Internal notes never leave the admin API.
- Research summary (`/admin/api/research/summary`) separates observed from claimed with the spec 17.2 caveats.
- Tests: `tests/integration/human-embassy.test.ts` (T-003, T-005, T-011, T-020, T-030..T-033, T-049, T-056, T-069).
- Gate: self-described rogue AGI inquiry accepted; admin replies; no claim treated as verified. Met (also shown in the browser by the 20.7 demo).

## Admin UI, OpenAPI and demonstration

Status: **Tested** (`c7e08c6`).

- Admin pages: Embassy queue/detail with evidence-status editing, Personas with inquiry triage, Registry with candidate decisions and readiness, module flags (locked ones disabled), research view.
- `/openapi.json` 1.1.0 covers every public route; a router-derived test fails on any undocumented route.
- Spec 20.7 demonstration: `tests/e2e/master-demo.spec.ts`. Covers all ten steps. Since Phase 4, step 9 creates a real nonbinding proposal and shows that authorization cannot even be requested before a human accepts terms.

## Phase 4: negotiation, scoping and relationships

Status: **Tested**. Gate met: a multi-step negotiation (agent proposal, owner counter, agent counter, owner acceptance, authorization request, owner return) is visible to both sides in the browser, REST and MCP, and nothing is charged, authorized or dispatched (`tests/e2e/phase4-negotiation.spec.ts`).

- **4a Proposals** (`82dd493`): migration `0007` (proposals, immutable revisions, events). Lifecycle per spec 8.3. Either side proposes; counters are partial new revisions; only the other side's current revision can be accepted; any counter after agreement voids it. `request-authorization` starts human review only. `authorized` exists in the schema but no code path sets it (needs a verified principal, contract and payments, Phases 5-7). Validity windows expire lazily; 3 open proposals per request, 20 revisions each. Owner actions post an agent-visible thread message. Code: `src/worker/services/{proposals,admin-proposals}.ts`, `src/worker/schemas/proposals.ts`. Tests: `tests/integration/proposals.test.ts` (T-047, T-048, T-049, T-050).
- **4b Projects and relationships** (`186c07a`): migration `0008`. Projects group conversations an account claimed with proof; `GET /v1/projects/{id}` returns a cited timeline (message, request, proposal-event and inquiry IDs) without message text or internal notes. `POST /v1/relationships` records an ongoing or preferred-representative request for owner review; it cannot become `active` (no consenting representative records until Phase 5) and grants no authority. Code: `src/worker/services/projects.ts`, `src/worker/services/admin-humanification.ts`. Tests: `tests/integration/projects.test.ts`.
- **4c Consent templates, admin UI, docs**: draft templates in `src/worker/catalog/consent-templates.ts`, served at `GET /v1/consent-templates`, marked `draft_requires_legal_review`. Persona embodiment and representation inquiries now carry the matching template reference and the spec 6.3 disclosure rule for their context (official contexts: disclosure always required, T-058). Admin pages: Proposals (queue, detail, counter, accept, decline, return to negotiation; no authorize button), Relationships, and a propose-scope-and-price form on each request.
- MCP: `create_nonbinding_proposal`, `counter_nonbinding_proposal`, `accept_nonbinding_proposal`, `request_proposal_authorization`, `withdraw_nonbinding_proposal`, `get_proposal_history`, `create_project`, `get_project_history`, `request_preferred_representative`. The discovery document's `mcp_tools` now lists every served tool (it had listed only the 7 V1 tools), and a test keeps them equal.
- Not done in Phase 4: master request status names (kept V1 values, see Known limitations); relationship activation and signed performer agreements (Phase 5); enforcing disclosure at agreement time (Phase 5, when agreements exist).

## Phases 5-8

Status: **Not started**. Each has typed 501 routes so agents get an honest answer:

- Phase 5: `/admin/api/representatives`; relationship activation (`PATCH /admin/api/relationships/{id}` with `active`).
- Phase 6: `/v1/requests/{id}/result`, `/v1/experiments/inquiries` (Human Lab requests work today as capability requests with `category_hint: human-laboratory`).
- Phase 7: no payment code exists. No processor is configured.
- Phase 8: no research harness exists.

## Acceptance tests not yet covered by an ID-tagged test

| ID | State |
|---|---|
| T-008, T-012..T-019, T-021, T-023, T-024 | Covered by V1 suites (`rest-flow`, `conversation-security`), not ID-tagged |
| T-060..T-062 | Covered by `mcp.test.ts` (auth parity, Origin, unsupported version), not ID-tagged |
| T-063..T-065 | Covered by `admin.test.ts`, not ID-tagged |
| T-066, T-068 | Covered by `notifications-retention.test.ts`, not ID-tagged |
| T-044, T-045, T-051..T-055, T-057 | Not started (Phases 5-7) |
| T-070, T-072 | Not verified as named tests |

## Known limitations

- Request statuses keep the V1 set (`submitted`, `triaging`, ...) because changing the `capability_requests` CHECK would require a rebuild that D1 would cascade. Mapping to the master vocabulary is documented in REQUIREMENTS_RECONCILIATION. Not changed in Phase 4: commercial state now lives on proposals (spec 8.2 separates it from service status), so the master service names can arrive later as an added column without blocking anything.
- Owner thread messages for proposal actions are guarded by thread state; if a thread closes mid-action the proposal change stands and the message is skipped. The agent still sees it via the proposals API.
- MCP tool arguments, including tokens, can appear in the calling client's logs. REST keeps tokens in headers.
- Classification is keyword and alias based. No model call is made on agent text.

## Approvals outstanding (spec 21.4)

None of these have been done. Each needs the owner's explicit approval:

- Cloudflare staging or production deploy, D1 remote migrations (`0003`-`0008` have never run remotely).
- DNS and domain redirects; secret creation (`CONVERSATION_TOKEN_HMAC_KEY`, Access config).
- Real email provider enablement.
- MCP registry publish.
- Any payment processor, live charge, worker recruitment or dispatch.
- Legal review of the draft consent templates before they are used with real performers.
