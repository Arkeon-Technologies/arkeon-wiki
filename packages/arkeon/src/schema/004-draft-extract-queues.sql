-- 004-draft-extract-queues.sql
-- Adds audit columns to wiki_draft_queue and creates source_extract_queue.
-- All statements are idempotent.

-- ---------------------------------------------------------------------------
-- wiki_draft_queue: audit and debugging columns
-- ---------------------------------------------------------------------------

ALTER TABLE wiki_draft_queue ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE wiki_draft_queue ADD COLUMN IF NOT EXISTS result_wiki_id TEXT;
ALTER TABLE wiki_draft_queue ADD COLUMN IF NOT EXISTS merged_into TEXT;
ALTER TABLE wiki_draft_queue ADD COLUMN IF NOT EXISTS context_dossier JSONB;

-- The draft worker creates simple redirects (placeholder -> existing wiki)
-- without going through the full perform_entity_merge() path.
-- entity_redirects has RLS enabled (003-wiki.sql) with only a SELECT policy,
-- so we need both the INSERT privilege and an RLS policy.
GRANT INSERT ON entity_redirects TO arke_app;

DROP POLICY IF EXISTS redirects_insert ON entity_redirects;
CREATE POLICY redirects_insert ON entity_redirects
  FOR INSERT TO arke_app
  WITH CHECK (current_actor_id() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- source_extract_queue: queue for the extract worker
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS source_extract_queue (
  entity_id    TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  owner_agent  TEXT NOT NULL REFERENCES actors(id),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','complete','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error        TEXT,
  placeholders_created INTEGER,
  started_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_extract_queue_pending_idx
  ON source_extract_queue (created_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON source_extract_queue TO arke_app;
