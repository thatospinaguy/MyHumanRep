# Requirements reconciliation: V1 build vs master spec v4.0

Source of truth: [`docs/specs/MYHUMANREP_MASTER_SPEC.md`](specs/MYHUMANREP_MASTER_SPEC.md) section 2.2 (ACC-01..ACC-18).
Audit method: every ACC item was checked against the code **and probed with live requests** using the master spec's own example payloads on the unmodified V1 build (commit `9b7aceb`, 96/96 tests passing) before any change.

Severity: **High** = an agent following the master spec is refused or misled. **Medium** = feature missing that the spec says must exist. **Low** = wording/docs.

## Probe results on unmodified V1 (2026-10-30)

| Probe | V1 result |
|---|---|
| `POST /v1/conversations` with `claimed_autonomy: "rogue_claimed"` (T-003) | **400** |
| `claimed_autonomy: "agi_claimed"`, `"not_stated"`, or free text | **400** |
| Spec 11.2 example (`intent: "human_embassy"`) | **400** |
| `preferred_language` | **400** |
| Spec 11.5 capability-request example (`desired_outcome`, `service_tags`, `persona_id`, `timing_preference`, `budget` object) | **400** (unknown fields) |
| `problem_statement` without `objective` | **400** |
| `/human-embassy`, `/humanification`, `/services/{slug}`, `/v1/capabilities/{slug}`, `/.well-known/myhumanrep.json`, `/v1/conversations/{id}/status` | **404** |
| `/v1/capabilities` `capabilities[]` registry | absent (6 example slugs only) |
| `X-Robots-Tag` on private API responses | absent |

## Matrix

| ID | V1 behavior found (code location) | Required behavior | Severity | Fix (code) | Migration | Test | Status |
|---|---|---|---|---|---|---|---|
| ACC-01 | First contact already needed only `message` (`schemas/api.ts` `CreateConversationInput`) | Same | none | none | none | `master-accessibility` T-002/T-004 | Compliant |
| ACC-02 | **`claimed_autonomy` was a strict 5-value enum** (`schemas/api.ts`); the spec's `rogue_claimed`/`agi_claimed`/`not_stated` and free text got 400. A V1 unit test asserted `'rogue'` must be rejected (`tests/unit/core.test.ts`). | Any claim accepted; stored unverified | **High** | `ClaimedAutonomy` accepts master + V1 vocab + free text; `services/self-reports.ts` `normalizeAutonomy`; contradictory unit test inverted | `0003`: `conversations.autonomy_claim`, `agent_self_reports` (+ backfill) | T-003, T-011, unit `input schemas` | **Fixed** |
| ACC-03 | No B2B filter existed | Same | none | none | none | T-004 | Compliant |
| ACC-04 | `category_hint` optional and free-form, but unknown values were not marked `unclassified` nor queued for review; spec 11.5 fields rejected | Optional hint; unknown → `unclassified` + candidate queue; spec fields accepted | **High** | `services/capability-catalog.ts` `classifyHints` + `candidateStatements`; `CapabilityRequestInput` accepts spec 8.1/11.5 fields; admin candidate queue (`services/admin-registry.ts`) | `0004` | T-006, T-026, `capability-registry.test.ts` | **Fixed (Phase 1)** |
| ACC-05 | No personhood field existed | Same | none | none | none | T-004 | Compliant |
| ACC-06 | No persona support at all | Original persona CRUD | Medium | `services/personas.ts`, `services/agent-accounts.ts`, `routes/humanification.ts` | `0005` | T-034..T-037, T-042, T-046 (`humanification.test.ts`) | **Fixed (Phase 2)** |
| ACC-07 | No forced "I AM AI" label anywhere (checked pages, MCP instructions, replies) | Context-sensitive attribution | none | none | none | copy review | Compliant |
| ACC-08 | `PROHIBITED` copy said "We will not help with ... bypassing human verification", readable as refusing the *topic* (`content.ts`) | Discussion allowed; only execution refused | Low | `PROHIBITED` rewritten: "You may discuss anything, including identity, human verification... We evaluate the action requested, never what the sender says it is." No code ever blocked by keyword | none | `ACC-08` test, T-028 | **Fixed** |
| ACC-09 | REST was already independent of MCP | Same | none | none | none | T-008 (rest-flow) | Compliant |
| ACC-10 | No upload/payment/booking needed | Same | none | none | none | T-002 | Compliant |
| ACC-11 | Public pages were already JS-free | Same | none | none | none | T-001/T-009 | Compliant |
| ACC-12 | No inbound side effects except owner alert | Same | none | none | none | T-022 | Compliant |
| ACC-13 | n/a (no personas) | Persona ID never authenticates | Medium | Personas require a separate scoped account credential (`mhra_`, own HMAC purpose); persona IDs never authorize; thread claims need the thread token | `0005` | ACC-13, T-036, T-038, T-039 | **Fixed (Phase 2)** |
| ACC-14 | Private responses were `no-store` but had no `X-Robots-Tag` (`middleware/security-headers.ts`) | no-store + noindex | Low | Every `no-store` response now carries `X-Robots-Tag: noindex, nofollow` | none | ACC-14 / T-067 | **Fixed** |
| ACC-15 | Self-report already optional | Same | none | none | none | T-032 | Compliant |
| ACC-16 | Copy already said environment may observe | Same; master 4.2 wording adopted | Low | `FOR_AGENTS_NOTICE` replaced with master 4.2 invitation verbatim; `AUDIENCE_NOTICE` added (rogue/independent/AGI self-descriptions welcome) | none | public tests | **Fixed** |
| ACC-17 | `README.md` and `DECISIONS.md` said V2-V4 were "intentionally not built", phrased as product scope | Historical release boundary, not prohibition | Low | Docs reframed as phased roadmap with feature flags (`docs/IMPLEMENTATION_STATUS.md`, README) | none | docs | **Fixed** |
| ACC-18 | Old V1/V1.5 spec lived at `docs/` and was referenced as the scope source | Master spec authoritative; old spec archived | Low | Master at `docs/specs/`; old spec moved to `docs/archive/`; `CLAUDE.md` points to master | none | docs | **Fixed** |

## Other V1 vs master differences (not ACC items)

| Topic | V1 | Master | Decision |
|---|---|---|---|
| Intent vocabulary | 4 values (CHECK constraint) | adds `human_embassy`, `humanification` | Accepted; stored in new `intent_label`, legacy column gets `other`. See ADR M2. |
| `language` | only `language` | `preferred_language` | Both accepted; contradictory values → `422 unprocessable_request`. |
| First status name | `waiting_for_human` | example shows `awaiting_human` | **Kept V1 value** (spec 2.3: don't silently change shapes). Documented mapping. |
| Capability request statuses | `submitted, triaging, clarification_requested, eligible_for_future_scoping, needs_authorization, declined, withdrawn` | `submitted, triage, needs_clarification, feasible_for_quote, requires_specialist_review, ineligible, declined` | **Kept V1 values for this release.** Changing them needs a `capability_requests` table rebuild (CHECK constraint) that would trigger `ON DELETE SET NULL` on message links. Planned with Phase 4 using a link-preserving copy migration. Mapping: triage≈`triaging`, needs_clarification≈`clarification_requested`, feasible_for_quote≈`eligible_for_future_scoping`, ineligible≈`declined`. `requires_specialist_review` has no V1 equivalent yet. |
| Error codes | no 422/501 | `unprocessable_request` 422, `not_yet_available` 501 | Added. |
| MCP tool names | `get_service_info`, `read_conversation`, `request_human_capability`, `list_capability_requests` | `discover_human_capabilities`, `read_messages`, `describe_human_need`, `get_capability_request_status`, `request_human_dialogue` | Both sets registered; V1 names kept for existing clients. |
| Notification outbox | 3 event types, conversation required | new event types, conversation optional | `notification_outbox` rebuilt in `0003` (it has no dependent tables; rows copied verbatim, tested by T-071). |
