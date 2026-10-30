-- V1.5: open-ended human capability requests.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS capability_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  -- SHA-256 of the canonical validated payload, for idempotent retries.
  payload_hash TEXT NOT NULL,
  objective TEXT NOT NULL,
  human_capability_needed TEXT,
  context TEXT,
  -- Optional, agent-supplied hint. Free text so novel categories are never rejected.
  category_hint TEXT,
  location_text TEXT,
  deadline_preference TEXT,
  -- Indicative, nonbinding budget in integer minor units (e.g. cents).
  budget_amount_minor INTEGER CHECK (budget_amount_minor IS NULL OR budget_amount_minor >= 0),
  budget_currency TEXT,
  deliverables TEXT,
  why_human TEXT,
  confidentiality_preference TEXT NOT NULL DEFAULT 'standard'
    CHECK (confidentiality_preference IN ('standard','request_discussion')),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','triaging','clarification_requested','eligible_for_future_scoping','needs_authorization','declined','withdrawn')),
  -- Agent-visible note written by the owner.
  public_status_note TEXT,
  -- Owner-only.
  internal_notes TEXT,
  internal_category TEXT,
  created_via TEXT NOT NULL DEFAULT 'rest' CHECK (created_via IN ('rest','mcp')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_capability_requests_status ON capability_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_requests_conversation ON capability_requests(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_requests_created ON capability_requests(created_at DESC, id DESC);

-- Additive: link messages (e.g. clarification questions) and alerts to a request.
ALTER TABLE messages ADD COLUMN capability_request_id TEXT REFERENCES capability_requests(id) ON DELETE SET NULL;
ALTER TABLE notification_outbox ADD COLUMN capability_request_id TEXT REFERENCES capability_requests(id) ON DELETE SET NULL;
