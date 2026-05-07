-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0

-- Per-edit audit log. One row per write, regardless of source:
-- worker via applyEdit, human via filesystem, watcher resync, etc.
-- Powers /entities/{id}/history and the trigger filter "fire on edits
-- not made by me" (loop safety for cascading workers).
CREATE TABLE IF NOT EXISTS entity_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

  -- Who made the edit. Worker role names ("ingestor", "synthesizer",
  -- ...) or "human" for filesystem-driven changes that didn't come
  -- through applyEdit.
  by_role TEXT NOT NULL,

  -- Semantic kind of the edit (more granular than FileEdit's
  -- write|edit|delete). 'resync' is the watcher reconciling external
  -- changes (e.g. a human saving in their editor).
  edit_kind TEXT NOT NULL CHECK (
    edit_kind IN ('create', 'append', 'replace', 'delete', 'resync')
  ),

  -- Optional one-line summary the writer chose to attach. Surfaced
  -- by /entities/{id}/history so an operator can see what changed
  -- without diffing.
  edit_note TEXT,

  -- Content hash of the file body after this edit. Used as the
  -- idempotency key so a watcher resync that observes the same file
  -- a worker just wrote does not double-insert. NULL for delete
  -- events.
  content_hash TEXT,

  at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(entity_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_entity_edits_entity_at
  ON entity_edits(entity_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_edits_role_at
  ON entity_edits(by_role, at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_edits_at
  ON entity_edits(at DESC);

-- Convenience view for "who/when/what last touched this entity".
-- Avoids denormalizing onto entities and keeps entity_edits as the
-- single source of truth. ROW_NUMBER over (id DESC) tie-breaks when
-- two edits land in the same datetime tick.
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
