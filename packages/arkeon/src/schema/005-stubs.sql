-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0
--
-- Add 'stub' to the entities.type CHECK constraint so unresolved
-- [[wikilink]] references can be persisted as placeholder entities.
-- A stub is created when a wiki body contains [[Label]] (or
-- [[Label|subject_type]]) and no entity already exists at the
-- wikiPathFor()-derived target path. Stubs are GC'd at the end of every
-- wiki sync if they have zero inbound relationships, and upgraded in
-- place to type='wiki' when a real wiki is written at their source_path
-- (the entity id is preserved so inbound relationships survive).
--
-- SQLite cannot ALTER a CHECK constraint, so this migration follows the
-- documented "12 steps" rebuild pattern. The runner has FKs disabled for
-- the duration of all migrations and runs PRAGMA foreign_key_check
-- afterwards, so the rebuild is safe even though the existing
-- relationships rows reference entities.
--
-- Idempotency: on subsequent startups this re-runs harmlessly. The
-- runner's BEGIN..COMMIT wraps it; if entities_new exists from a prior
-- failed run, the leading DROP clears it.

DROP TABLE IF EXISTS entities_new;

CREATE TABLE entities_new (
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

INSERT INTO entities_new (
  id, space_id, type, label, source_path, source_hash, properties,
  created_at, updated_at
)
SELECT
  id, space_id, type, label, source_path, source_hash, properties,
  created_at, updated_at
FROM entities;

DROP TABLE entities;

ALTER TABLE entities_new RENAME TO entities;

-- Indexes from 001-foundation.sql were dropped with the old table; recreate.
CREATE INDEX IF NOT EXISTS idx_entities_space ON entities(space_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(space_id, type);

-- Hot path for the GC pass that runs after every wiki sync: "give me
-- every stub in this space" + then the per-id existence check against
-- relationships.target_id (which already has idx_relationships_target).
CREATE INDEX IF NOT EXISTS idx_entities_stubs
  ON entities(space_id) WHERE type = 'stub';
