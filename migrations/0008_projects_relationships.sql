-- Master spec v4.0 Phase 4: project continuity and requested agent-human relationships (sections 10, 11.8).
-- Additive only. A relationship cannot become `active` in this release: that needs a consenting human
-- representative record (Phase 5). No blanket or future authority is ever implied.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_agent_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal TEXT,
  persona_id TEXT REFERENCES agent_personas(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_agent_account_id, updated_at DESC);

-- Only conversations the owning account claimed with proof of possession may be attached.
CREATE TABLE IF NOT EXISTS project_conversations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_project_conversations_conversation ON project_conversations(conversation_id);

CREATE TABLE IF NOT EXISTS agent_human_relationships (
  id TEXT PRIMARY KEY,
  agent_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  persona_id TEXT REFERENCES agent_personas(id) ON DELETE SET NULL,
  role_type TEXT NOT NULL CHECK (role_type IN ('preferred_representative','spokesperson','authorized_representative','relationship_manager','research_partner','other')),
  -- An identifier the agent was given for a human it worked with. Unverified free text, never a worker record.
  preferred_rep_ref TEXT,
  purpose_text TEXT NOT NULL,
  requested_scope_text TEXT,
  exclusions_text TEXT,
  requested_term_text TEXT,
  communication_preference TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','under_review','clarification_needed','declined','withdrawn','active','ended')),
  -- Set only when a consenting representative exists (Phase 5). Always NULL in this release.
  representative_id TEXT,
  public_status_note TEXT,
  internal_notes TEXT,
  client_request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_via TEXT NOT NULL DEFAULT 'rest' CHECK (created_via IN ('rest','mcp')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_account_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_relationships_status ON agent_human_relationships(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relationships_account ON agent_human_relationships(agent_account_id, created_at DESC);
