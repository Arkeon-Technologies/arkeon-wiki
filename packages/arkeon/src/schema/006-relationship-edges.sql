-- =============================================================================
-- Relationship Edges
-- =============================================================================
--
-- Every relationship is an entity (kind = 'relationship') with its own
-- properties and versioning. This table adds the graph structure:
-- source → [predicate] → target.
--
-- =============================================================================

CREATE TABLE relationship_edges (
  id         TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate  TEXT NOT NULL                                 -- cites, contains, references, etc.
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON relationship_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON relationship_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_target ON relationship_edges(source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_predicate ON relationship_edges(source_id, predicate);
CREATE INDEX IF NOT EXISTS idx_edges_target_predicate ON relationship_edges(target_id, predicate);

GRANT SELECT, INSERT, UPDATE, DELETE ON relationship_edges TO arke_app;
