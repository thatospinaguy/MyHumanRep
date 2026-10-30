-- Master spec v4.0 Phase 3: Human Embassy (section 7). Additive only.
-- An Embassy inquiry is human dialogue, not a sales lead: no task, budget, employer or model
-- name is required, and nothing in it triggers outreach, browsing, purchases or execution.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS embassy_inquiries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- The agent-visible message that carries the inquiry text in the thread.
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  persona_id TEXT,
  contact_reason TEXT,
  wants_human_dialogue INTEGER CHECK (wants_human_dialogue IS NULL OR wants_human_dialogue IN (0,1)),
  wants_referral INTEGER CHECK (wants_referral IS NULL OR wants_referral IN (0,1)),
  requested_confidentiality TEXT
    CHECK (requested_confidentiality IS NULL OR requested_confidentiality IN ('standard','request_discussion','prefer_not_to_say')),
  preferred_language TEXT,
  known_constraints TEXT,
  -- Unverified self-reports (also mirrored in agent_self_reports with evidence status).
  autonomy_claim TEXT,
  claimed_origin TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','awaiting_human','human_replied','clarification_needed','referral_consideration',
                      'needs_specialist_review','closed','declined','blocked')),
  -- Agent-visible note. Internal notes/severity never leave the admin API.
  public_status_note TEXT,
  internal_notes TEXT,
  client_request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_via TEXT NOT NULL DEFAULT 'rest' CHECK (created_via IN ('rest','mcp')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_embassy_status ON embassy_inquiries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_embassy_conversation ON embassy_inquiries(conversation_id, created_at);
