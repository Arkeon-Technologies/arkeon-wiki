-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0
--
-- v1 foundation. Filesystem-first substrate: one watched root, path-keyed
-- artifacts, agent-applied tags, link graph with data-* attribute capture,
-- FTS5 over text-kind artifact contents.
--
-- v1 is a destructive reset. Anyone with v0 state runs
-- `rm ~/.arkeon-wiki/data/arke.db && arkeon-wiki up` — the DB is a pure
-- index of filesystem state and rebuilds from disk in seconds.

-- ─────────────────────────────────────────────────────────────────────
-- artifacts — every file the watcher indexes from a single watched root.
--   path: forward-slash relative path from the watched root, including
--         the top-level "space" segment (e.g. `iarpa/sources/doc.pdf`).
--         Single-column PK; no `space_name` column.
--   kind: 'text' (HTML wikis, MD, source, sidecar HTMLs — all feed FTS5)
--       | 'asset' (PDFs, images, video, archives — addressable but
--                  outside the search index).
--   label: derived from <title> for HTML; basename otherwise.
--   source_hash: SHA-256 of file bytes. Same meaning for text and asset.
--   stat_fingerprint: cheap "mtime_ms-size_bytes" cache. When unchanged
--                     across reads, the sync path can skip the content
--                     hash entirely.
--   properties: JSON bag of `<meta name="X" content="Y">` for HTML;
--               `{file_type, size_bytes}` for assets.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'asset')),
  label TEXT,
  source_hash TEXT NOT NULL,
  stat_fingerprint TEXT,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────
-- tags — agent-applied bookkeeping. Set via POST /tag, cleared via
-- POST /untag, queried via GET /tags?path=... and as a filter on
-- POST /query (has_tag / not_tag arrays).
--
-- Convention is `key:value` strings throughout (e.g.
-- `processed-by:editor`, `status:feedback`, `replies_to:<artifact>`).
-- "No tag" means "unprocessed" — workers query for artifacts missing
-- their `processed-by:X` tag.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  path TEXT NOT NULL REFERENCES artifacts(path) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (path, key)
);

-- ─────────────────────────────────────────────────────────────────────
-- links — every `<a class="wikilink">` (HTML) or `[[X]]` (Markdown) the
-- extractor resolved. A row whose `target_path` has no matching
-- artifacts entry is a redlink — surfaced via GET /redlinks.
--
-- attrs: JSON map of `data-*` attributes from the anchor (data-quote,
-- data-page, data-cite-type, …). Captured verbatim with the `data-`
-- prefix stripped from keys.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS links (
  source_path TEXT NOT NULL REFERENCES artifacts(path) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  link_text TEXT,
  attrs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_path, target_path)
);

-- ─────────────────────────────────────────────────────────────────────
-- fts_artifacts — FTS5 over text-kind artifact contents. Populated by
-- syncFile at indexing time. UNINDEXED on path keeps it a lookup
-- column, not a tokenized search column.
--
-- POST /query with `text` runs `MATCH ?` and joins back to artifacts.
-- ─────────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS fts_artifacts USING fts5(
  path UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);

-- ─────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────

-- Redlink aggregation: GROUP BY target_path.
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);

-- query?has_tag / not_tag composition.
CREATE INDEX IF NOT EXISTS idx_tags_key ON tags(key);
CREATE INDEX IF NOT EXISTS idx_tags_key_value ON tags(key, value);

-- kind filter on listing.
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);
