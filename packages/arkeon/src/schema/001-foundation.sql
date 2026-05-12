-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0
--
-- v0 foundation. Path-keyed knowledge graph, no ULIDs except for
-- conversations (which have no on-disk file to derive identity from).
--
-- Six tables, no migration history: this is the v0 reset point.
-- Anyone with in-flight state does `rm ~/.arkeon-wiki/data/arke.db`.

-- ─────────────────────────────────────────────────────────────────────
-- 1. spaces — daemon-level: each space is one watched directory.
-- Name is the URL-visible identity; watch_dir is the local mapping.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spaces (
  name TEXT PRIMARY KEY,
  watch_dir TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. entities — every file the watcher indexes. Path is the identity.
--   type: 'wiki' (HTML article under wiki/, authored by the writer)
--       | 'file' (everything else — sources, notes, images, anything)
--   label: <title> for wikis, basename for sources.
--   properties: JSON map of <meta name="..." content="..."> tags.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  space_name TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('wiki', 'file')),
  label TEXT,
  source_hash TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_name, source_path)
);

-- ─────────────────────────────────────────────────────────────────────
-- 3. relationships — every <a href> the link extractor resolved.
-- No FK on target_path: a row whose target has no matching entity is
-- a red link. Resolution is a LEFT JOIN at query time.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relationships (
  space_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  link_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_name, source_path, target_path),
  FOREIGN KEY (space_name, source_path)
    REFERENCES entities(space_name, source_path) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────
-- 4. entity_edits — audit log. Not FK'd to entities so history survives
-- entity deletion (useful for the recent-edits feed). by_role='human'
-- when fs-watcher syncs a file the agent didn't write.
-- ─────────────────────────────────────────────────────────────────────
-- `at` carries millisecond precision (strftime '%f') so two edits to the
-- same path within a second don't collide on the composite PK. ISO-8601
-- TEXT sorts chronologically alongside the simpler datetime('now') used
-- elsewhere — just with finer resolution where it matters.
CREATE TABLE IF NOT EXISTS entity_edits (
  space_name TEXT NOT NULL,
  entity_path TEXT NOT NULL,
  by_role TEXT NOT NULL,
  edit_kind TEXT NOT NULL,
  edit_note TEXT,
  content_hash TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (space_name, entity_path, at)
);

-- ─────────────────────────────────────────────────────────────────────
-- 5. conversations — chat sessions. The one v0 table where ID is the
-- right model: conversations have no on-disk analog. Phase 3 wires the
-- routes; Phase 1 lays the schema so Phase 3 is purely additive.
-- article_path nullable: null = general chat, not anchored to an article.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  space_name TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE,
  article_path TEXT,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────
-- 6. conversation_messages — content stores the full AI SDK message
-- shape (text + tool_calls + tool_results) as JSON for replay.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, seq)
);

-- ─────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────

-- Hot path for the red-link aggregation: GROUP BY target_path.
-- Also covers inbound counts on entity listing.
CREATE INDEX IF NOT EXISTS idx_relationships_target
  ON relationships(space_name, target_path);

-- Recent-edits feed and "unprocessed sources" sort.
CREATE INDEX IF NOT EXISTS idx_entities_updated
  ON entities(space_name, updated_at);

-- Entity-by-type filter on listing (e.g. type='file' for unprocessed sources).
CREATE INDEX IF NOT EXISTS idx_entities_type
  ON entities(space_name, type);

-- Recent-edits feed across the whole space.
CREATE INDEX IF NOT EXISTS idx_entity_edits_at
  ON entity_edits(space_name, at);

-- Per-entity history lookup ("show me edits to this path").
CREATE INDEX IF NOT EXISTS idx_entity_edits_entity_at
  ON entity_edits(space_name, entity_path, at DESC);

-- Conversation list per space, newest first.
CREATE INDEX IF NOT EXISTS idx_conversations_space_updated
  ON conversations(space_name, updated_at DESC);
