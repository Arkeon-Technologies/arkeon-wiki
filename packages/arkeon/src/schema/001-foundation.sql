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

-- Entities: wikis, source files, and [[wikilink]]-derived stubs.
-- A stub is created when a wiki body contains [[Label]] (or
-- [[Label|subject_type]]) and no entity exists at the wikiPathFor()
-- path yet. Stubs are GC'd in sync once nothing points at them, and
-- upgraded in place to type='wiki' when a real wiki is written at
-- their source_path (entity id is preserved so inbound relationships
-- survive).
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('wiki', 'file', 'stub')),
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

-- Hot path for the GC pass that runs after every wiki sync: "give me
-- every stub in this space" + a per-id existence check against
-- relationships.target_id (which already has idx_relationships_target).
CREATE INDEX IF NOT EXISTS idx_entities_stubs
  ON entities(space_id) WHERE type = 'stub';

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

-- Supports recency queries: "recent failed runs" for diagnostics,
-- "runs in the last hour" for monitoring. Cheap insurance while the
-- schema is fresh.
CREATE INDEX IF NOT EXISTS idx_agent_runs_finished
  ON agent_runs(role, finished_at);

-- Agent queue: persistent FIFO of (space, role, source) work items.
-- A row is INSERTed when a watcher event triggers an agent role, and
-- DELETEd on successful completion. On failure, started_at is cleared
-- and last_error recorded; the next claim will retry. The lease
-- pattern (started_at + 5min orphan reclaim on daemon startup) makes
-- it crash-safe without distributed-locking infrastructure.
--
-- The UNIQUE(space_id, role, trigger_path) coalesces rapid file saves:
-- if a source is saved 5 times before its first run drains, the row
-- is upserted (latest entity_id, started_at reset) so we run once
-- against the latest content rather than queueing 5 redundant runs.
CREATE TABLE IF NOT EXISTS agent_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  trigger_path TEXT NOT NULL,
  trigger_entity_id TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE(space_id, role, trigger_path)
);

-- Hot path for the worker: "next pending work item for a role,
-- ordered by enqueue time."
CREATE INDEX IF NOT EXISTS idx_agent_queue_pending
  ON agent_queue(role, enqueued_at)
  WHERE started_at IS NULL;
