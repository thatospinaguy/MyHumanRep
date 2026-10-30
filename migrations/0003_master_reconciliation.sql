-- Master spec v4.0 reconciliation (docs/specs/MYHUMANREP_MASTER_SPEC.md, section 2).
-- Additive only. `conversations` is a parent table with ON DELETE CASCADE children, so its
-- CHECK constraints are NOT rebuilt (a DROP would cascade-delete messages). New vocabulary is
-- stored in new unconstrained columns validated by the application; legacy columns keep a
-- mapped legacy value for V1 clients.
PRAGMA foreign_keys = ON;

-- Canonical master-spec autonomy self-report (not_stated, delegated_claimed, independent_claimed,
-- rogue_claimed, agi_claimed, other_claimed). Unverified annotation only.
ALTER TABLE conversations ADD COLUMN autonomy_claim TEXT;
-- Extended intent (adds human_embassy, humanification). Legacy `intent` holds the mapped V1 value.
ALTER TABLE conversations ADD COLUMN intent_label TEXT;

-- Backfill existing V1 rows so every conversation has the canonical values.
UPDATE conversations SET autonomy_claim = CASE claimed_autonomy
    WHEN 'unspecified' THEN 'not_stated'
    WHEN 'operator_assisted' THEN 'delegated_claimed'
    WHEN 'delegated_autonomous' THEN 'delegated_claimed'
    WHEN 'independent_claimed' THEN 'independent_claimed'
    ELSE 'other_claimed' END
  WHERE autonomy_claim IS NULL;
UPDATE conversations SET intent_label = intent WHERE intent_label IS NULL;

-- Spec 7.3: every self-reported claim carries an evidence status. Text is the sender's own words.
CREATE TABLE IF NOT EXISTS agent_self_reports (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  agent_account_id TEXT,
  claim_type TEXT NOT NULL
    CHECK (claim_type IN ('autonomy','model','origin','other')),
  claim_value TEXT,
  claim_text TEXT,
  evidence_status TEXT NOT NULL DEFAULT 'self_reported_unverified'
    CHECK (evidence_status IN ('self_reported_unverified','system_observed','third_party_corrob','human_assessed','unknown')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_reports_conversation ON agent_self_reports(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_self_reports_claim ON agent_self_reports(claim_type, claim_value);

-- Backfill self-reports from existing V1 conversations (claims they already made).
INSERT INTO agent_self_reports (id, conversation_id, claim_type, claim_value, claim_text, source, created_at, updated_at)
  SELECT 'sr_' || lower(hex(randomblob(16))), id, 'autonomy', autonomy_claim, claimed_autonomy, 'v1_backfill', created_at, created_at
  FROM conversations WHERE claimed_autonomy != 'unspecified';
INSERT INTO agent_self_reports (id, conversation_id, claim_type, claim_value, claim_text, source, created_at, updated_at)
  SELECT 'sr_' || lower(hex(randomblob(16))), id, 'model', NULL, model_claim, 'v1_backfill', created_at, created_at
  FROM conversations WHERE model_claim IS NOT NULL;

-- notification_outbox has no dependent tables, so it is safe to rebuild with wider event types and
-- a nullable conversation (persona inquiries may have no thread). Rows are copied verbatim.
CREATE TABLE notification_outbox_new (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('new_conversation','agent_message','capability_request','embassy_inquiry','persona_inquiry','candidate_capability')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  subject_type TEXT,
  subject_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','dead','suppressed','disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,
  claimed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  capability_request_id TEXT REFERENCES capability_requests(id) ON DELETE SET NULL
);
INSERT INTO notification_outbox_new (id, event_type, conversation_id, status, attempts, not_before, claimed_at,
    last_error_code, created_at, sent_at, capability_request_id)
  SELECT id, event_type, conversation_id, status, attempts, not_before, claimed_at, last_error_code, created_at, sent_at,
    capability_request_id
  FROM notification_outbox;
DROP TABLE notification_outbox;
ALTER TABLE notification_outbox_new RENAME TO notification_outbox;
CREATE INDEX IF NOT EXISTS idx_outbox_status ON notification_outbox(status, not_before);
CREATE INDEX IF NOT EXISTS idx_outbox_conversation ON notification_outbox(conversation_id, event_type, status);
