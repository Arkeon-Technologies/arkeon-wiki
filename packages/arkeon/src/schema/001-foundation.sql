-- 001-foundation.sql
-- Filesystem-first knowledge graph schema (SQLite).
-- All migrations must be idempotent (run twice = no error).

-- Spaces: a watched directory on disk
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  watch_dir TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Entities: wikis and source files
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('wiki', 'file')),
  label TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_hash TEXT,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(space_id, source_path)
);

-- Relationship edges between entities
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL DEFAULT 'references',
  link_text TEXT,
  link_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, predicate)
);

CREATE INDEX IF NOT EXISTS idx_entities_space ON entities(space_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(space_id, type);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);

-- Contributions: pending or consumed inputs to a wiki from a source.
-- Frontmatter is canonical; this table mirrors `contributions[]` in the
-- target wiki's frontmatter and exists only as a query index (e.g. "wikis
-- with N pending contributions").
CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  wiki_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  excerpt TEXT,
  claim TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT,
  consumed_in_revision INTEGER
);

CREATE INDEX IF NOT EXISTS idx_contributions_wiki ON contributions(wiki_id);
CREATE INDEX IF NOT EXISTS idx_contributions_pending
  ON contributions(wiki_id) WHERE consumed_at IS NULL;

-- Agent runs: idempotency tracking for the agent runtime. Keyed by
-- (role, idempotency_key); the input_hash lets the runtime decide
-- whether a re-trigger of the same key represents new work or a replay.
CREATE TABLE IF NOT EXISTS agent_runs (
  role TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  finished_at TEXT NOT NULL DEFAULT (datetime('now')),
  error TEXT,
  PRIMARY KEY (role, idempotency_key)
);
