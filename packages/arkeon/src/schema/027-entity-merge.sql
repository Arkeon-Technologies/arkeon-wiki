-- =============================================================================
-- Entity Merge Support
-- =============================================================================
--
-- Adds:
--   1. entity_redirects table — maps merged entity IDs to their canonical target
--   2. perform_entity_merge() — SECURITY DEFINER function for merge mutations
--      (bypasses RLS since the app layer verifies admin access before calling)
--
-- The merge function is the ONLY writer to entity_redirects, and the ONLY
-- code path that repoints edges or transfers space memberships across
-- entities. No additional RLS policies are needed because SECURITY
-- DEFINER bypasses RLS entirely.
--
-- =============================================================================

-- Redirect table for merged entities
CREATE TABLE entity_redirects (
  old_id     TEXT PRIMARY KEY,
  new_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  merged_at  TIMESTAMPTZ NOT NULL,
  merged_by  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_redirects_new ON entity_redirects(new_id);

-- arke_app only needs SELECT (for redirect lookups on GET).
-- All writes go through the SECURITY DEFINER function.
GRANT SELECT ON entity_redirects TO arke_app;

ALTER TABLE entity_redirects ENABLE ROW LEVEL SECURITY;

CREATE POLICY redirects_select ON entity_redirects
FOR SELECT TO arke_app
USING (true);


-- =============================================================================
-- SECURITY DEFINER merge function
-- =============================================================================
--
-- Performs all merge mutations with elevated privileges. The app layer MUST
-- verify admin access on both source and target before calling this function.
--
-- This bypasses RLS because merge needs to:
--   - Delete/repoint relationship entities owned by third parties
--   - Transfer space memberships for spaces the actor may not have roles in
--   - Write to entity_redirects (no INSERT grant to arke_app)
--
-- Returns the updated target entity row, or empty set if the CAS check failed.
--
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
  -- 1. Delete self-referential edges (source ↔ target)
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

  -- 6. (entity_permissions removed — no-op)

  -- 7. Transfer space memberships (skip duplicates, use merge actor as added_by)
  INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
  SELECT space_id, p_target_id, p_actor_id, p_now
  FROM space_entities WHERE entity_id = p_source_id
  ON CONFLICT (space_id, entity_id) DO NOTHING;

  -- 8. Update target entity with merged properties (CAS guard)
  UPDATE entities
  SET properties = p_merged_properties,
      ver = p_new_ver,
      edited_by = p_actor_id,
      note = p_note,
      updated_at = p_now
  WHERE id = p_target_id AND ver = p_expected_ver
  RETURNING * INTO v_updated;

  -- If CAS failed, abort — return empty set so caller gets 409
  IF v_updated.id IS NULL THEN
    RETURN;
  END IF;

  -- 9. Insert version snapshot
  INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
  VALUES (p_target_id, p_new_ver, p_merged_properties, p_actor_id, p_note, p_now);

  -- 10. Repoint existing redirects that point to source (chain resolution)
  UPDATE entity_redirects SET new_id = p_target_id WHERE new_id = p_source_id;

  -- 11. Insert redirect for the source
  INSERT INTO entity_redirects (old_id, new_id, merged_at, merged_by)
  VALUES (p_source_id, p_target_id, p_now, p_actor_id);

  -- 12. Delete source entity (CASCADE handles remaining refs)
  DELETE FROM entities WHERE id = p_source_id;

  -- Return the updated target
  RETURN NEXT v_updated;
END;
$$;

-- Harden: only arke_app can call this function, not PUBLIC
REVOKE ALL ON FUNCTION perform_entity_merge FROM PUBLIC;
GRANT EXECUTE ON FUNCTION perform_entity_merge TO arke_app;
