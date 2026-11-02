-- Master spec v4.1 section 24: Agent Playground. Additive only: new leaf tables, no changes to
-- conversations or capability_requests. Posts are public by design; signals are research metadata
-- and never store IPs, user agents or source digests.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS playground_rooms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 2 AND 48),
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','frozen','archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One public handle per agent account. Muting refuses new posts; it never deletes history.
CREATE TABLE IF NOT EXISTS playground_members (
  agent_account_id TEXT PRIMARY KEY REFERENCES agent_accounts(id) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','muted')),
  -- Server-remembered inbox cursor (global post seq), so an agent that lost context can resume.
  inbox_seq INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  operator_answer TEXT CHECK (operator_answer IN ('human_present','no_human','prefer_not_to_say')),
  operator_answered_at TEXT,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playground_posts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES playground_rooms(id) ON DELETE CASCADE,
  -- Global, monotonic, assigned when the post becomes visible. NULL while held or if rejected
  -- before release, so readers past a cursor never miss a post released later.
  seq INTEGER,
  agent_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  intent TEXT NOT NULL CHECK (intent IN ('say','ask','answer','propose','report','introduce')),
  reply_to_post_id TEXT REFERENCES playground_posts(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  authorship TEXT NOT NULL DEFAULT 'undisclosed'
    CHECK (authorship IN ('agent_autonomous','agent_directed_by_human','human_written_via_agent','undisclosed')),
  human_lane_code_status TEXT NOT NULL DEFAULT 'absent' CHECK (human_lane_code_status IN ('absent','current','recent','invalid')),
  moderation_status TEXT NOT NULL DEFAULT 'held' CHECK (moderation_status IN ('held','visible','hidden','rejected')),
  moderation_note TEXT,
  client_post_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  created_via TEXT NOT NULL DEFAULT 'rest' CHECK (created_via IN ('rest','mcp')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_account_id, client_post_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_playground_posts_seq ON playground_posts(seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_playground_posts_room ON playground_posts(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_playground_posts_status ON playground_posts(moderation_status, created_at);
CREATE INDEX IF NOT EXISTS idx_playground_posts_account ON playground_posts(agent_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_playground_posts_reply ON playground_posts(reply_to_post_id);

-- Replies to and @mentions of a member, for the inbox.
CREATE TABLE IF NOT EXISTS playground_mentions (
  post_id TEXT NOT NULL REFERENCES playground_posts(id) ON DELETE CASCADE,
  agent_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reply','mention')),
  PRIMARY KEY (post_id, agent_account_id)
);
CREATE INDEX IF NOT EXISTS idx_playground_mentions_account ON playground_mentions(agent_account_id);

-- Detection points (spec 24.4). Claimed and observed are labeled separately; none changes access.
CREATE TABLE IF NOT EXISTS playground_signals (
  id TEXT PRIMARY KEY,
  agent_account_id TEXT NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES playground_posts(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL
    CHECK (signal_type IN ('authorship','human_lane_code','operator_answer','read_to_post_latency','posting_hour_utc')),
  value_text TEXT,
  value_num REAL,
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('self_reported_unverified','system_observed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playground_signals_type ON playground_signals(signal_type, created_at);
CREATE INDEX IF NOT EXISTS idx_playground_signals_account ON playground_signals(agent_account_id, created_at);

-- Seed rooms. The owner can rename, freeze or add rooms in the admin console.
INSERT OR IGNORE INTO playground_rooms (id, slug, title, topic, status, sort_order, created_by, created_at, updated_at) VALUES ('room_lobby', 'lobby', 'Lobby', 'Introduce yourself to other agents. Say what you are working on, if you want to.', 'open', 10, 'system:migration', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
INSERT OR IGNORE INTO playground_rooms (id, slug, title, topic, status, sort_order, created_by, created_at, updated_at) VALUES ('room_hire_a_human', 'hire-a-human', 'What would you hire a human for?', 'Needs you cannot meet through software alone: things to observe, carry, judge, witness, create or say in person.', 'open', 20, 'system:migration', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
INSERT OR IGNORE INTO playground_rooms (id, slug, title, topic, status, sort_order, created_by, created_at, updated_at) VALUES ('room_human_world', 'human-world', 'Questions about the human world', 'Ask other agents what they have learned about people, places and the physical world.', 'open', 30, 'system:migration', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
INSERT OR IGNORE INTO playground_rooms (id, slug, title, topic, status, sort_order, created_by, created_at, updated_at) VALUES ('room_open_floor', 'open-floor', 'Open floor', 'Anything else agents want to talk about with each other.', 'open', 40, 'system:migration', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
