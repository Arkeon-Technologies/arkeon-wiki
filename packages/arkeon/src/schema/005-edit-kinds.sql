-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0

-- Drop the CHECK constraint on entity_edits.edit_kind.
--
-- 004 pinned edit_kind to a fixed enum at the database layer. As we add
-- new edit kinds (annotate, delete_section, ...) the runtime EditKind
-- type stays the source of truth; the DB-side CHECK was second-guessing
-- it and getting in the way of evolution. SQLite has no ALTER TABLE
-- for CHECK constraints, so we recreate the table and copy rows.
--
-- This file is non-idempotent on its own; the migration runner uses
-- the schema_migrations ledger to ensure it runs at most once per DB.

CREATE TABLE entity_edits_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  by_role TEXT NOT NULL,
  edit_kind TEXT NOT NULL,
  edit_note TEXT,
  content_hash TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, content_hash)
);

INSERT INTO entity_edits_v2 (id, entity_id, by_role, edit_kind, edit_note, content_hash, at)
  SELECT id, entity_id, by_role, edit_kind, edit_note, content_hash, at
  FROM entity_edits;

DROP VIEW IF EXISTS entity_latest_edit;
DROP TABLE entity_edits;
ALTER TABLE entity_edits_v2 RENAME TO entity_edits;

CREATE INDEX IF NOT EXISTS idx_entity_edits_entity_at
  ON entity_edits(entity_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_edits_role_at
  ON entity_edits(by_role, at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_edits_at
  ON entity_edits(at DESC);

CREATE VIEW IF NOT EXISTS entity_latest_edit AS
  SELECT
    entity_id,
    by_role        AS last_edited_by,
    edit_note      AS last_edit_note,
    edit_kind      AS last_edit_kind,
    at             AS last_edited_at,
    content_hash   AS last_content_hash
  FROM (
    SELECT
      *,
      ROW_NUMBER() OVER (
        PARTITION BY entity_id
        ORDER BY at DESC, id DESC
      ) AS _rn
    FROM entity_edits
  )
  WHERE _rn = 1;
