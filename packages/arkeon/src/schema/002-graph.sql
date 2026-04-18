-- =============================================================================
-- Knowledge Graph: Entities, Edges, Versions, Merges
-- =============================================================================

-- =============================================================================
-- Entities — nodes of the knowledge graph
-- =============================================================================

CREATE TABLE IF NOT EXISTS entities (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  type       TEXT NOT NULL,
  ver        INTEGER NOT NULL DEFAULT 1,
  properties JSONB NOT NULL DEFAULT '{}',
  owner_id   TEXT NOT NULL REFERENCES actors(id),
  edited_by  TEXT NOT NULL REFERENCES actors(id),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT valid_kind CHECK (kind IN ('entity', 'relationship'))
);

CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_kind_type_updated ON entities(kind, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
CREATE INDEX IF NOT EXISTS idx_entities_edited_by ON entities(edited_by, updated_at DESC);

-- Functional index for upsert on (type, label)
CREATE INDEX IF NOT EXISTS idx_entities_type_label_lower
  ON entities (type, lower(properties->>'label'))
  WHERE kind = 'entity' AND properties->>'label' IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO arke_app;


-- =============================================================================
-- Relationship Edges — graph structure: source -> [predicate] -> target
-- =============================================================================

CREATE TABLE IF NOT EXISTS relationship_edges (
  id         TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON relationship_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON relationship_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_target ON relationship_edges(source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_predicate ON relationship_edges(source_id, predicate);
CREATE INDEX IF NOT EXISTS idx_edges_target_predicate ON relationship_edges(target_id, predicate);

GRANT SELECT, INSERT, UPDATE, DELETE ON relationship_edges TO arke_app;


-- =============================================================================
-- Entity Versions — append-only content snapshots
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_versions (
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  ver        INTEGER NOT NULL,
  properties JSONB NOT NULL,
  edited_by  TEXT NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (entity_id, ver)
);

CREATE INDEX IF NOT EXISTS idx_versions_entity_desc ON entity_versions(entity_id, ver DESC);

GRANT SELECT, INSERT ON entity_versions TO arke_app;


-- =============================================================================
-- Entity Redirects — merged entity ID mappings
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_redirects (
  old_id     TEXT PRIMARY KEY,
  new_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  merged_at  TIMESTAMPTZ NOT NULL,
  merged_by  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_redirects_new ON entity_redirects(new_id);

GRANT SELECT ON entity_redirects TO arke_app;


-- =============================================================================
-- Merge Functions (SECURITY DEFINER — bypass RLS for merge mutations)
-- =============================================================================

CREATE OR REPLACE FUNCTION perform_entity_merge(
  p_source_id TEXT,
  p_target_id TEXT,
  p_merged_properties JSONB,
  p_new_ver INTEGER,
  p_expected_ver INTEGER,
  p_actor_id TEXT,
  p_note TEXT,
  p_now TIMESTAMPTZ,
  p_merge_detail JSONB
) RETURNS SETOF entities
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated entities;
BEGIN
  -- 1. Delete self-referential edges (source <-> target)
  DELETE FROM entities WHERE id IN (
    SELECT re.id FROM relationship_edges re
    WHERE (re.source_id = p_source_id AND re.target_id = p_target_id)
       OR (re.source_id = p_target_id AND re.target_id = p_source_id)
  );

  -- 2. Delete duplicate outgoing edges
  DELETE FROM entities WHERE id IN (
    SELECT src_edge.id FROM relationship_edges src_edge
    WHERE src_edge.source_id = p_source_id
    AND EXISTS (
      SELECT 1 FROM relationship_edges tgt_edge
      WHERE tgt_edge.source_id = p_target_id
      AND tgt_edge.target_id = src_edge.target_id
      AND tgt_edge.predicate = src_edge.predicate
    )
  );

  -- 3. Delete duplicate incoming edges
  DELETE FROM entities WHERE id IN (
    SELECT src_edge.id FROM relationship_edges src_edge
    WHERE src_edge.target_id = p_source_id
    AND EXISTS (
      SELECT 1 FROM relationship_edges tgt_edge
      WHERE tgt_edge.target_id = p_target_id
      AND tgt_edge.source_id = src_edge.source_id
      AND tgt_edge.predicate = src_edge.predicate
    )
  );

  -- 4. Repoint remaining outgoing edges
  UPDATE relationship_edges SET source_id = p_target_id WHERE source_id = p_source_id;

  -- 5. Repoint remaining incoming edges
  UPDATE relationship_edges SET target_id = p_target_id WHERE target_id = p_source_id;

  -- 6. Transfer space memberships (skip duplicates)
  INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
  SELECT space_id, p_target_id, p_actor_id, p_now
  FROM space_entities WHERE entity_id = p_source_id
  ON CONFLICT (space_id, entity_id) DO NOTHING;

  -- 7. Update target entity with merged properties (CAS guard)
  UPDATE entities
  SET properties = p_merged_properties,
      ver = p_new_ver,
      edited_by = p_actor_id,
      note = p_note,
      updated_at = p_now
  WHERE id = p_target_id AND ver = p_expected_ver
  RETURNING * INTO v_updated;

  IF v_updated.id IS NULL THEN
    RETURN;
  END IF;

  -- 8. Insert version snapshot
  INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
  VALUES (p_target_id, p_new_ver, p_merged_properties, p_actor_id, p_note, p_now);

  -- 9. Repoint existing redirects that point to source (chain resolution)
  UPDATE entity_redirects SET new_id = p_target_id WHERE new_id = p_source_id;

  -- 10. Insert redirect for the source
  INSERT INTO entity_redirects (old_id, new_id, merged_at, merged_by)
  VALUES (p_source_id, p_target_id, p_now, p_actor_id);

  -- 11. Delete source entity (CASCADE handles remaining refs)
  DELETE FROM entities WHERE id = p_source_id;

  RETURN NEXT v_updated;
END;
$$;

REVOKE ALL ON FUNCTION perform_entity_merge FROM PUBLIC;
GRANT EXECUTE ON FUNCTION perform_entity_merge TO arke_app;


-- Batch merge: merges an array of sources into a single target.
CREATE OR REPLACE FUNCTION perform_group_merge(
  p_target_id TEXT,
  p_source_ids TEXT[],
  p_merged_properties JSONB,
  p_start_ver INTEGER,
  p_actor_id TEXT,
  p_now TIMESTAMPTZ,
  p_merge_details JSONB[]
) RETURNS SETOF entities
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated entities;
  v_source_id TEXT;
  v_expected_ver INTEGER;
  v_new_ver INTEGER;
  v_i INTEGER;
  v_count INTEGER;
  v_is_last BOOLEAN;
BEGIN
  v_expected_ver := p_start_ver;
  v_count := array_length(p_source_ids, 1);

  FOR v_i IN 1..v_count LOOP
    v_source_id := p_source_ids[v_i];
    v_new_ver := v_expected_ver + 1;
    v_is_last := (v_i = v_count);

    -- 1. Delete self-referential edges
    DELETE FROM entities WHERE id IN (
      SELECT re.id FROM relationship_edges re
      WHERE (re.source_id = v_source_id AND re.target_id = p_target_id)
         OR (re.source_id = p_target_id AND re.target_id = v_source_id)
    );

    -- 2. Delete duplicate outgoing edges
    DELETE FROM entities WHERE id IN (
      SELECT src_edge.id FROM relationship_edges src_edge
      WHERE src_edge.source_id = v_source_id
      AND EXISTS (
        SELECT 1 FROM relationship_edges tgt_edge
        WHERE tgt_edge.source_id = p_target_id
        AND tgt_edge.target_id = src_edge.target_id
        AND tgt_edge.predicate = src_edge.predicate
      )
    );

    -- 3. Delete duplicate incoming edges
    DELETE FROM entities WHERE id IN (
      SELECT src_edge.id FROM relationship_edges src_edge
      WHERE src_edge.target_id = v_source_id
      AND EXISTS (
        SELECT 1 FROM relationship_edges tgt_edge
        WHERE tgt_edge.target_id = p_target_id
        AND tgt_edge.source_id = src_edge.source_id
        AND tgt_edge.predicate = src_edge.predicate
      )
    );

    -- 4. Repoint remaining outgoing edges
    UPDATE relationship_edges SET source_id = p_target_id WHERE source_id = v_source_id;

    -- 5. Repoint remaining incoming edges
    UPDATE relationship_edges SET target_id = p_target_id WHERE target_id = v_source_id;

    -- 6. Transfer space memberships
    INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
    SELECT space_id, p_target_id, p_actor_id, p_now
    FROM space_entities WHERE entity_id = v_source_id
    ON CONFLICT (space_id, entity_id) DO NOTHING;

    -- 7. Update target entity (CAS guard on first iteration only)
    IF v_i = 1 THEN
      UPDATE entities
      SET properties = CASE WHEN v_is_last THEN p_merged_properties ELSE properties END,
          ver = v_new_ver,
          edited_by = p_actor_id,
          note = 'batch merge',
          updated_at = p_now
      WHERE id = p_target_id AND ver = v_expected_ver
      RETURNING * INTO v_updated;

      IF v_updated.id IS NULL THEN
        RETURN;
      END IF;
    ELSE
      UPDATE entities
      SET properties = CASE WHEN v_is_last THEN p_merged_properties ELSE properties END,
          ver = v_new_ver,
          edited_by = p_actor_id,
          note = 'batch merge',
          updated_at = p_now
      WHERE id = p_target_id
      RETURNING * INTO v_updated;
    END IF;

    -- 8. Version snapshot only on last iteration
    IF v_is_last THEN
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (p_target_id, v_new_ver, p_merged_properties, p_actor_id, 'batch merge', p_now);
    END IF;

    -- 9. Repoint existing redirects (chain resolution)
    UPDATE entity_redirects SET new_id = p_target_id WHERE new_id = v_source_id;

    -- 10. Insert redirect for the source
    INSERT INTO entity_redirects (old_id, new_id, merged_at, merged_by)
    VALUES (v_source_id, p_target_id, p_now, p_actor_id);

    -- 11. Delete source entity
    DELETE FROM entities WHERE id = v_source_id;

    v_expected_ver := v_new_ver;
  END LOOP;

  RETURN NEXT v_updated;
END;
$$;

REVOKE ALL ON FUNCTION perform_group_merge FROM PUBLIC;
GRANT EXECUTE ON FUNCTION perform_group_merge TO arke_app;
