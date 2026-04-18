-- =============================================================================
-- Core Entities Table
-- =============================================================================
--
-- Entities are the nodes of the knowledge graph. Relationships are also
-- entities (kind = 'relationship') with additional edge data in
-- relationship_edges.
--
-- =============================================================================

CREATE TABLE entities (
  -- Identity
  id         TEXT PRIMARY KEY,                              -- ULID
  kind       TEXT NOT NULL,                                 -- 'entity' | 'relationship'
  type       TEXT NOT NULL,                                 -- semantic: book, chapter, person, etc.

  -- Version chain (content versions only)
  ver        INTEGER NOT NULL DEFAULT 1,                    -- monotonically increasing

  -- Content
  properties JSONB NOT NULL DEFAULT '{}',                   -- type-specific data

  -- Ownership (references actors, not self)
  owner_id   TEXT NOT NULL REFERENCES actors(id),

  -- Audit
  edited_by  TEXT NOT NULL REFERENCES actors(id),           -- actor who made latest content edit
  note       TEXT,                                          -- optional version note

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL,                         -- immutable
  updated_at TIMESTAMPTZ NOT NULL,                         -- bumped on content changes only

  -- Constraints
  CONSTRAINT valid_kind CHECK (kind IN ('entity', 'relationship'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_kind_type_updated ON entities(kind, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
CREATE INDEX IF NOT EXISTS idx_entities_edited_by ON entities(edited_by, updated_at DESC);

-- Grant table access to app role
GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO arke_app;

