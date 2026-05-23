-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0
--
-- Asset indexing + stat-fingerprint cache.
--
-- (1) `kind` splits `entities` into:
--       'text'  — corpus material the agents read and process.
--                 Wikis (always text) and source files that the watcher
--                 classified as text-shaped.
--       'asset' — binary attachments (images, PDFs, audio, video,
--                 archives, fonts...). Indexed so links to them resolve,
--                 but never enter the agent queues.
--     Existing rows are all text by definition (the prior denylist
--     refused to index anything else), so DEFAULT 'text' fits without a
--     backfill. Queue queries (editor / proposer / connector) gain a
--     `kinds: ['text']` clause to keep assets out of the work feed.
--
-- (2) `stat_fingerprint` is a cheap change-detection cache, distinct
--     from `source_hash` (which stays canonical SHA-256 of content for
--     every kind). The sync path compares the file's current
--     `mtime_ms-size_bytes` against the stored fingerprint; if they
--     match, the bytes are guaranteed unchanged and we skip the
--     content read AND the hash recomputation. On a miss, the real
--     content hash is computed; if THAT matches the stored
--     `source_hash`, the change was a touch (refresh the fingerprint,
--     keep everything else). This makes large-asset sync ~free on
--     unchanged files and keeps `source_hash` semantically uniform
--     across text and asset rows. NULL is the bootstrap value; existing
--     rows populate on their next sync tick.

ALTER TABLE entities ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'
  CHECK (kind IN ('text', 'asset'));

ALTER TABLE entities ADD COLUMN stat_fingerprint TEXT;

-- Queue queries always include (space_name, kind, type) in their WHERE.
-- The existing idx_entities_type covers (space_name, type); this index
-- adds the kind dimension so the planner can use both columns as a
-- composite key for queue filters.
CREATE INDEX IF NOT EXISTS idx_entities_kind
  ON entities(space_name, kind, type);
