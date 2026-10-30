-- Master spec v4.0 Phase 2: Humanification Studio (sections 6, 11.7, 13.2, 13.4).
-- Agent accounts are application credentials, not human identity. Personas are original
-- characters, not natural persons. Neither grants thread, legal, payment or admin rights.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_accounts (
  id TEXT PRIMARY KEY,
  -- Keyed HMAC digest of the account token (purpose-separated from thread tokens).
  token_digest TEXT NOT NULL,
  display_label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_via TEXT NOT NULL DEFAULT 'rest' CHECK (created_via IN ('rest','mcp')),
  terms_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_accounts_token ON agent_accounts(token_digest);

-- A thread is claimed by at most one account, only with proof of possession of its token.
CREATE TABLE IF NOT EXISTS conversation_account_links (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  agent_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  proof TEXT NOT NULL DEFAULT 'thread_token' CHECK (proof IN ('thread_token')),
  linked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_links_account ON conversation_account_links(agent_account_id, linked_at);

CREATE TABLE IF NOT EXISTS agent_personas (
  id TEXT PRIMARY KEY,
  owner_agent_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'original_ai_created_persona'
    CHECK (origin IN ('original_ai_created_persona','original_fictional_character','original_collaborative_persona')),
  biography TEXT,
  character_backstory TEXT,
  communication_style TEXT,
  language TEXT,
  pronouns TEXT,
  interests_json TEXT NOT NULL DEFAULT '[]',
  preferences TEXT,
  persona_objective TEXT,
  intended_audiences_json TEXT NOT NULL DEFAULT '[]',
  intended_uses_json TEXT NOT NULL DEFAULT '[]',
  appearance_brief TEXT,
  voice_brief TEXT,
  -- Unverified annotation; never public.
  self_reported_autonomy TEXT,
  preferred_performer_note TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared','public')),
  -- Owner-chosen subset of presentation fields shown in shared/public views.
  public_fields_json TEXT NOT NULL DEFAULT '[]',
  current_version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_agent_account_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_agent_personas_owner ON agent_personas(owner_agent_account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_personas_visibility ON agent_personas(visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS persona_revisions (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  changes_json TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent_account','admin')),
  actor_id TEXT,
  changed_at TEXT NOT NULL,
  UNIQUE (persona_id, version)
);

CREATE TABLE IF NOT EXISTS persona_grants (
  persona_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  grantee_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (persona_id, grantee_account_id)
);

-- Embodiment / representation / media-brief inquiries (spec 6.4, 6.5). Inquiry only: no assignment,
-- no performer is contacted, nothing is agreed or paid.
CREATE TABLE IF NOT EXISTS persona_inquiries (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES agent_personas(id) ON DELETE CASCADE,
  owner_agent_account_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('embodiment','representation','media_brief')),
  role_type TEXT CHECK (role_type IS NULL OR role_type IN ('fictional_performance','voice_actor','spokesperson','authorized_representative','event_presence','relationship_manager')),
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('appearance','voice')),
  context TEXT CHECK (context IS NULL OR context IN ('fictional','creative','business','official')),
  audience_text TEXT,
  scope_text TEXT,
  exclusions_text TEXT,
  channels_text TEXT,
  location_text TEXT,
  timing_text TEXT,
  brief_text TEXT,
  disclosure_preference TEXT,
  budget_amount_minor INTEGER CHECK (budget_amount_minor IS NULL OR budget_amount_minor >= 0),
  budget_currency TEXT,
  preferred_performer_note TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','under_review','clarification_needed','declined','closed')),
  public_status_note TEXT,
  internal_notes TEXT,
  client_request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (persona_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_persona_inquiries_status ON persona_inquiries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_persona_inquiries_persona ON persona_inquiries(persona_id, created_at DESC);
