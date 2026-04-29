-- 002-chunks.sql
-- Per-wiki chunks for embedding-based search (issue #47).
-- This migration only sets up storage. The chunker itself is gated
-- behind ARKEON_WIKI_CHUNKING=1 (see syncWikiFile). The embedder
-- and vec0 virtual table arrive in follow-up PRs.

CREATE TABLE IF NOT EXISTS entity_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_kind    TEXT NOT NULL CHECK (chunk_kind IN ('card', 'section', 'section_part')),
  heading_path  TEXT NOT NULL,
  start_line    INTEGER,
  end_line      INTEGER,
  text          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_entity_chunks_entity ON entity_chunks(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_chunks_kind ON entity_chunks(entity_id, chunk_kind);
