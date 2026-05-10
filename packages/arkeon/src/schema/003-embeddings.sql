-- 003-embeddings.sql
-- Vector storage for chunk embeddings (issue #47).
-- Requires the sqlite-vec extension to be loaded on the connection
-- before this migration runs. initDb() in src/server/lib/sql.ts calls
-- sqliteVec.load(db) immediately after opening the connection.
--
-- Two tables. Keeping the vector store and the metadata separate:
--   - chunk_vectors holds just the float vectors. vec0 is a virtual
--     table — no triggers, no FK *to* it, no ALTER. Joins via chunk_id.
--   - entity_embeddings is a regular pivot tracking which model + which
--     chunk content_hash produced each row, so we can detect stale
--     embeddings and re-embed without dropping the vec0 row.

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[256] distance_metric=cosine
);

CREATE TABLE IF NOT EXISTS entity_embeddings (
  chunk_id      INTEGER PRIMARY KEY REFERENCES entity_chunks(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_embeddings_model
  ON entity_embeddings(model);

-- Per-entity work queue for the embedder. Watcher writes here after
-- syncWikiFile finishes; a per-process worker drains it asynchronously.
-- Lease pattern (started_at + 5min orphan reclaim) makes it crash-safe
-- without distributed-locking infrastructure: if the daemon dies
-- mid-embed, the row's started_at ages out and the next worker startup
-- reclaims it.
--
-- UNIQUE(entity_id) coalesces rapid edits: if a wiki is saved 5 times
-- before the first embedding run drains, the row is upserted (started_at
-- reset) so we embed once against the latest chunks rather than queueing
-- 5 redundant runs.
CREATE TABLE IF NOT EXISTS embedding_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  enqueued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  UNIQUE(entity_id)
);

CREATE INDEX IF NOT EXISTS idx_embedding_queue_pending
  ON embedding_queue(enqueued_at)
  WHERE started_at IS NULL;
