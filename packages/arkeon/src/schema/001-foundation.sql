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
