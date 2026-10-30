-- Master spec v4.0 Phase 4: versioned nonbinding proposals and counteroffers (sections 8.3, 8.4, 11.8).
-- Additive only. A proposal never charges, contracts, assigns or dispatches anything: `authorized` exists
-- for the future L3 flow (verified principal + payment, Phase 7) and no code path in this release sets it.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  capability_request_id TEXT NOT NULL REFERENCES capability_requests(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('draft','proposed','countered','terms_agreed_nonbinding','awaiting_authorization','authorized','cancelled','expired')),
  current_revision INTEGER NOT NULL DEFAULT 1,
  -- Revision both sides accepted (nonbinding). Cleared whenever a counteroffer changes the terms.
  agreed_revision INTEGER,
  initiated_by TEXT NOT NULL CHECK (initiated_by IN ('agent','admin')),
  -- Agent idempotency for the first revision; NULL for owner-created proposals.
  client_request_id TEXT,
  payload_hash TEXT,
  expires_at TEXT NOT NULL,
  internal_notes TEXT,
  created_via TEXT NOT NULL CHECK (created_via IN ('rest','mcp','admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (capability_request_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_proposals_request ON proposals(capability_request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, updated_at DESC);

-- Immutable terms per version (spec 8.4). A counteroffer is a new row, never an update.
CREATE TABLE IF NOT EXISTS proposal_revisions (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent','admin')),
  scope_text TEXT NOT NULL,
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  timing_text TEXT,
  location_text TEXT,
  required_skills_json TEXT NOT NULL DEFAULT '[]',
  evidence_requirements TEXT,
  cancellation_terms TEXT,
  confidentiality TEXT,
  price_minor INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  valid_until TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  material_change INTEGER NOT NULL DEFAULT 0 CHECK (material_change IN (0,1)),
  note TEXT,
  client_request_id TEXT,
  payload_hash TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, revision),
  UNIQUE (proposal_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS proposal_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('created','countered','accepted_nonbinding','agreement_invalidated',
    'authorization_requested','returned_to_negotiation','declined','withdrawn','expired')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent','admin','system')),
  revision INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal ON proposal_events(proposal_id, created_at);
