-- 007-drop-deprecated.sql
-- Phase 0 cleanup: drop the chunker/embedder/agent_runs tables that
-- the previous architecture created. Fresh installs never had them
-- (no-op); existing dev databases drop the regular tables here.
--
-- Stale `chunk_vectors` virtual tables on legacy dev DBs cannot be
-- dropped without the sqlite-vec extension loaded. Those operators
-- should reset the DB file (~/.arkeon-wiki/data/arke.db). For the
-- realistic case — fresh installs and dev DBs without chunk_vectors
-- — this migration is a simple set of no-op drops.

DROP TABLE IF EXISTS entity_embeddings;
DROP TABLE IF EXISTS entity_chunks;
DROP TABLE IF EXISTS embedding_queue;
DROP TABLE IF EXISTS agent_runs;
