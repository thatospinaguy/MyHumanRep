-- MyHumanRep Agent Contact: V1 Agent Inbox schema.
-- All timestamps are UTC ISO-8601 strings with millisecond precision
-- (YYYY-MM-DDTHH:MM:SS.sssZ) so lexical order equals chronological order.
-- D1 enforces foreign keys by default; the PRAGMA is kept for local sqlite tooling.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  -- Keyed HMAC-SHA-256 digest of the conversation token. Plaintext tokens are never stored.
  token_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting_for_human'
    CHECK (status IN ('open','waiting_for_human','human_replied','waiting_for_agent','closed')),
  intent TEXT NOT NULL DEFAULT 'general_inquiry'
    CHECK (intent IN ('general_inquiry','capability_request','research_question','other')),
  -- Self-reported, unverified sender annotations.
  sender_label TEXT,
  model_claim TEXT,
  claimed_autonomy TEXT NOT NULL DEFAULT 'unspecified'
    CHECK (claimed_autonomy IN ('unspecified','operator_assisted','delegated_autonomous','independent_claimed','other')),
  language TEXT,
  subject TEXT,
  -- Internal (owner-only) fields. Never exposed through the agent API.
  internal_priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (internal_priority IN ('low','normal','high','urgent')),
  internal_tags_json TEXT NOT NULL DEFAULT '[]',
  internal_notes TEXT,
  under_review INTEGER NOT NULL DEFAULT 0 CHECK (under_review IN (0,1)),
  retention_hold INTEGER NOT NULL DEFAULT 0 CHECK (retention_hold IN (0,1)),
  -- Observed interface ('rest' or 'mcp'), never a guessed model identity.
  created_via TEXT NOT NULL DEFAULT 'rest' CHECK (created_via IN ('rest','mcp')),
  -- Keyed digest of an optional client_request_id used to reject duplicate first contacts.
  create_request_digest TEXT UNIQUE,
  agent_message_count INTEGER NOT NULL DEFAULT 0,
  human_message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT CHECK (closed_by IS NULL OR closed_by IN ('agent','admin')),
  blocked_at TEXT,
  last_agent_message_at TEXT,
  last_human_message_at TEXT,
  last_agent_read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_expires ON conversations(expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Per-conversation monotonic sequence; the basis of agent pagination cursors.
  seq INTEGER NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('agent','human','system_notice')),
  body TEXT NOT NULL,
  client_message_id TEXT,
  body_hash TEXT,
  via TEXT NOT NULL DEFAULT 'rest' CHECK (via IN ('rest','mcp','admin','system')),
  created_at TEXT NOT NULL,
  -- First time the conversation credential holder retrieved this (human/system) message.
  delivered_at TEXT,
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('new_conversation','agent_message','capability_request')),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','dead','suppressed','disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,
  claimed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON notification_outbox(status, not_before);
CREATE INDEX IF NOT EXISTS idx_outbox_conversation ON notification_outbox(conversation_id, event_type, status);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  admin_subject TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  -- Non-sensitive metadata only. Never message bodies or credentials.
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action, created_at DESC);

CREATE TABLE IF NOT EXISTS abuse_events (
  id TEXT PRIMARY KEY,
  event_category TEXT NOT NULL,
  request_id TEXT,
  -- Keyed, truncated digest of the approximate source. Never a raw IP address.
  correlation_digest TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abuse_events_created ON abuse_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_events_expires ON abuse_events(expires_at);

-- Fixed-window application-layer quota counters.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires ON rate_limit_counters(expires_at);

-- Owner-editable, non-secret operational settings.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
