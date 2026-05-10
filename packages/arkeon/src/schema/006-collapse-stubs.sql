-- Copyright (c) 2026 Arkeon Technologies, Inc.
-- SPDX-License-Identifier: Apache-2.0

-- Collapse the 'stub' entity type into placeholder wikis.
--
-- Pre-006: type IN ('wiki', 'file', 'stub'). A [[wikilink]] miss inserted
-- type='stub' with source_hash=NULL; the orphan-GC ran on type='stub'.
--
-- Post-006: only ('wiki', 'file'). A [[wikilink]] miss still produces a
-- row with source_hash=NULL — the absence of a file on disk is the
-- placeholder signal — but the row's type is 'wiki'. The GC's filter
-- becomes (type='wiki' AND source_hash IS NULL).
--
-- Existing data is migrated in place. Inbound relationships, cascades,
-- chunks/embeddings, edit logs all reference entities.id which is
-- preserved across the UPDATE. The check constraint stays permissive
-- of 'stub' so we don't have to do the SQLite table-recreate dance with
-- six FK-cascading dependents — the TS EntityType ('wiki' | 'file') is
-- the runtime gate, and `parseEntityTypes` rejects 'stub' at the API
-- boundary, so no new 'stub' rows can land here going forward.

UPDATE entities SET type = 'wiki' WHERE type = 'stub';

-- Old partial index — narrowed by type='stub'. Replace with a partial
-- index on the new placeholder signal so the GC stays cheap.
DROP INDEX IF EXISTS idx_entities_stubs;

CREATE INDEX IF NOT EXISTS idx_entities_unresolved
  ON entities(space_id) WHERE type = 'wiki' AND source_hash IS NULL;
