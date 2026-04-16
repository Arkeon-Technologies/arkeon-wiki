-- Wiki draft queue for background processing of placeholder entities.
-- Phase 1 creates the table; Phase 2 adds the polling worker.

CREATE TABLE IF NOT EXISTS wiki_draft_queue (
  entity_id    TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  depth        INTEGER NOT NULL DEFAULT 0,
  owner_agent  TEXT NOT NULL REFERENCES actors(id),
  deadline     TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','complete','failed','undraftable')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wiki_draft_queue_pending_idx
  ON wiki_draft_queue (created_at) WHERE status = 'pending';
