-- 005-enrich-queue.sql
-- Queue for the enrich worker: tracks wiki enrichment jobs.
-- All statements are idempotent.

CREATE TABLE IF NOT EXISTS wiki_enrich_queue (
  id             TEXT PRIMARY KEY,
  target_wiki_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  space_id       TEXT NOT NULL,
  owner_agent    TEXT NOT NULL REFERENCES actors(id),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','processing','complete','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  error          TEXT,
  started_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_wiki_id, source_id)
);

CREATE INDEX IF NOT EXISTS wiki_enrich_queue_pending_idx
  ON wiki_enrich_queue (created_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON wiki_enrich_queue TO arke_app;
