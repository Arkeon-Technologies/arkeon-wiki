-- =============================================================================
-- Batch Entity Merge Support
-- =============================================================================
--
-- Adds perform_group_merge() — merges an array of source entities into a single
-- target entity in one transaction. Same 12-step logic as perform_entity_merge()
-- but looped over multiple sources.
--
-- CAS is checked on the first iteration only. Subsequent ver increments are
-- deterministic within the transaction.
--
-- Only the final iteration writes the merged properties and a version snapshot.
-- Intermediate iterations just bump ver and log the merge activity. This avoids
-- creating noisy intermediate version entries.
--
-- =============================================================================

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

    -- 1. Delete self-referential edges (source <-> target)
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

    -- 6. Transfer permissions (skip duplicates)
    INSERT INTO entity_permissions (entity_id, grantee_type, grantee_id, role, granted_by, granted_at)
    SELECT p_target_id, grantee_type, grantee_id, role, granted_by, granted_at
    FROM entity_permissions WHERE entity_id = v_source_id
    ON CONFLICT (entity_id, grantee_type, grantee_id) DO NOTHING;

    -- 7. Transfer space memberships
    INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
    SELECT space_id, p_target_id, p_actor_id, p_now
    FROM space_entities WHERE entity_id = v_source_id
    ON CONFLICT (space_id, entity_id) DO NOTHING;

    -- 8. Update target entity
    -- CAS guard on first iteration; properties only written on last iteration
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

    -- 9. Version snapshot only on last iteration (avoids noisy intermediates)
    IF v_is_last THEN
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (p_target_id, v_new_ver, p_merged_properties, p_actor_id, 'batch merge', p_now);
    END IF;

    -- 10. Repoint existing redirects that point to source (chain resolution)
    UPDATE entity_redirects SET new_id = p_target_id WHERE new_id = v_source_id;

    -- 11. Insert redirect for the source
    INSERT INTO entity_redirects (old_id, new_id, merged_at, merged_by)
    VALUES (v_source_id, p_target_id, p_now, p_actor_id);

    -- 12. Delete source entity (CASCADE handles remaining refs)
    DELETE FROM entities WHERE id = v_source_id;

    v_expected_ver := v_new_ver;
  END LOOP;

  -- Return the final updated target
  RETURN NEXT v_updated;
END;
$$;

-- Harden: only arke_app can call this function, not PUBLIC
REVOKE ALL ON FUNCTION perform_group_merge FROM PUBLIC;
GRANT EXECUTE ON FUNCTION perform_group_merge TO arke_app;
