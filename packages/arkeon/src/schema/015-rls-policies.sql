-- =============================================================================
-- Row-Level Security Policies
-- =============================================================================
--
-- RLS enforces BOTH classification AND ACL.
--   - Reads: classification check (integer comparison)
--   - Writes: classification ceiling + ACL (owner/editor/admin)
--
-- The app layer can still do pre-checks for better error messages (403 vs 404),
-- but the database is the final authority. A route that forgets to check
-- permissions will still be blocked by RLS.
--
-- Session context (set by middleware per request):
--   app.actor_id          — authenticated actor's ID
--   app.actor_read_level  — actor's max_read_level (int, -1 if unauth)
--   app.actor_write_level — actor's max_write_level (int, -1 if unauth)
--   app.actor_is_admin    — actor's is_admin flag (bool)
--
-- =============================================================================


-- =============================================================================
-- DROP existing policies so this file is fully re-runnable.
-- =============================================================================

DROP POLICY IF EXISTS entities_select        ON entities;
DROP POLICY IF EXISTS entities_insert        ON entities;
DROP POLICY IF EXISTS entities_update        ON entities;
DROP POLICY IF EXISTS entities_delete        ON entities;
DROP POLICY IF EXISTS entity_perms_select    ON entity_permissions;
DROP POLICY IF EXISTS entity_perms_insert    ON entity_permissions;
DROP POLICY IF EXISTS entity_perms_delete    ON entity_permissions;
DROP POLICY IF EXISTS edges_select           ON relationship_edges;
DROP POLICY IF EXISTS edges_insert           ON relationship_edges;
DROP POLICY IF EXISTS edges_delete           ON relationship_edges;
DROP POLICY IF EXISTS versions_select        ON entity_versions;
DROP POLICY IF EXISTS versions_insert        ON entity_versions;
DROP POLICY IF EXISTS actors_select          ON actors;
DROP POLICY IF EXISTS actors_insert          ON actors;
DROP POLICY IF EXISTS actors_update          ON actors;
DROP POLICY IF EXISTS actors_delete          ON actors;
DROP POLICY IF EXISTS spaces_select          ON spaces;
DROP POLICY IF EXISTS spaces_insert          ON spaces;
DROP POLICY IF EXISTS spaces_update          ON spaces;
DROP POLICY IF EXISTS spaces_delete          ON spaces;
DROP POLICY IF EXISTS space_perms_select     ON space_permissions;
DROP POLICY IF EXISTS space_perms_insert     ON space_permissions;
DROP POLICY IF EXISTS space_perms_update     ON space_permissions;
DROP POLICY IF EXISTS space_perms_delete     ON space_permissions;
DROP POLICY IF EXISTS space_entities_select  ON space_entities;
DROP POLICY IF EXISTS space_entities_insert  ON space_entities;
DROP POLICY IF EXISTS space_entities_delete  ON space_entities;
DROP POLICY IF EXISTS api_keys_select        ON api_keys;
DROP POLICY IF EXISTS api_keys_insert        ON api_keys;
DROP POLICY IF EXISTS api_keys_update        ON api_keys;
DROP POLICY IF EXISTS agent_keys_select      ON agent_keys;
DROP POLICY IF EXISTS agent_keys_insert      ON agent_keys;


-- =============================================================================
-- HELPER: check if current actor has a given role (or higher) on an entity
-- =============================================================================
--
-- Checks: direct actor grant only. Group grants were removed in 043.
-- role_check should be an array of acceptable roles.
--
-- =============================================================================

CREATE OR REPLACE FUNCTION actor_has_entity_role(
  p_entity_id TEXT,
  p_roles TEXT[]
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM entity_permissions ep
    WHERE ep.entity_id = p_entity_id
      AND ep.role = ANY(p_roles)
      AND ep.grantee_type = 'actor'
      AND ep.grantee_id = current_actor_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;


CREATE OR REPLACE FUNCTION actor_has_space_role(
  p_space_id TEXT,
  p_roles TEXT[]
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM space_permissions sp
    WHERE sp.space_id = p_space_id
      AND sp.role = ANY(p_roles)
      AND sp.grantee_type = 'actor'
      AND sp.grantee_id = current_actor_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- =============================================================================
-- ENTITIES
-- =============================================================================

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

-- SELECT: classification-gated reads
CREATE POLICY entities_select ON entities
FOR SELECT TO arke_app
USING (
  read_level = 0
  OR current_actor_read_level() >= read_level
);

-- INSERT: classification ceiling (creator becomes owner, no ACL check needed)
CREATE POLICY entities_insert ON entities
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

-- UPDATE: classification ceiling + ACL
-- Must be owner, have editor/admin grant, or be system admin
CREATE POLICY entities_update ON entities
FOR UPDATE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_entity_role(id, ARRAY['editor', 'admin'])
  )
)
WITH CHECK (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

-- DELETE: classification ceiling (read + write) + admin ACL
-- Must be owner, have admin grant, or be system admin
CREATE POLICY entities_delete ON entities
FOR DELETE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_entity_role(id, ARRAY['admin'])
  )
);


-- =============================================================================
-- ENTITY PERMISSIONS
-- =============================================================================

ALTER TABLE entity_permissions ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent entity is visible (classification-gated)
CREATE POLICY entity_perms_select ON entity_permissions
FOR SELECT TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND (e.read_level = 0 OR current_actor_read_level() >= e.read_level)
  )
);

-- INSERT: must be owner or admin of the entity
CREATE POLICY entity_perms_insert ON entity_permissions
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND e.owner_id = current_actor_id()
  )
  OR actor_has_entity_role(entity_id, ARRAY['admin'])
);

-- DELETE: must be owner or admin of the entity
CREATE POLICY entity_perms_delete ON entity_permissions
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND e.owner_id = current_actor_id()
  )
  OR actor_has_entity_role(entity_id, ARRAY['admin'])
);


-- =============================================================================
-- RELATIONSHIP EDGES
-- =============================================================================

ALTER TABLE relationship_edges ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the relationship entity is visible (classification check)
CREATE POLICY edges_select ON relationship_edges
FOR SELECT TO arke_app
USING (
  EXISTS (
    SELECT 1 FROM entities
    WHERE entities.id = relationship_edges.id
    AND (entities.read_level = 0 OR current_actor_read_level() >= entities.read_level)
  )
);

-- INSERT: must have edit access on the source entity AND read access on the target
CREATE POLICY edges_insert ON relationship_edges
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR (
    EXISTS (
      SELECT 1 FROM entities e
      WHERE e.id = source_id
      AND (
        e.owner_id = current_actor_id()
        OR actor_has_entity_role(e.id, ARRAY['editor', 'admin'])
      )
    )
    AND EXISTS (
      SELECT 1 FROM entities e
      WHERE e.id = target_id
      AND (e.read_level = 0 OR current_actor_read_level() >= e.read_level)
    )
  )
);

-- DELETE: must have edit access on the source entity or own the relationship
CREATE POLICY edges_delete ON relationship_edges
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = relationship_edges.id
    AND e.owner_id = current_actor_id()
  )
  OR EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = source_id
    AND (
      e.owner_id = current_actor_id()
      OR actor_has_entity_role(e.id, ARRAY['editor', 'admin'])
    )
  )
);


-- =============================================================================
-- ENTITY VERSIONS
-- =============================================================================

ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent entity is visible
CREATE POLICY versions_select ON entity_versions
FOR SELECT TO arke_app
USING (
  EXISTS (
    SELECT 1 FROM entities
    WHERE entities.id = entity_versions.entity_id
    AND (entities.read_level = 0 OR current_actor_read_level() >= entities.read_level)
  )
);

-- INSERT: must have edit access on the parent entity
CREATE POLICY versions_insert ON entity_versions
FOR INSERT TO arke_app
WITH CHECK (
  EXISTS (
    SELECT 1 FROM entities e
    WHERE e.id = entity_id
    AND (
      e.owner_id = current_actor_id()
      OR current_actor_is_admin()
      OR actor_has_entity_role(e.id, ARRAY['editor', 'admin'])
    )
  )
);


-- =============================================================================
-- ACTORS
-- =============================================================================

ALTER TABLE actors ENABLE ROW LEVEL SECURITY;

-- All actors visible to everyone
CREATE POLICY actors_select ON actors
FOR SELECT TO arke_app
USING (true);

-- INSERT: any authenticated actor can create actors at or below their own level
-- Admins can create at any level
CREATE POLICY actors_insert ON actors
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR (
    current_actor_id() IS NOT NULL
    AND max_read_level <= current_actor_read_level()
    AND max_write_level <= current_actor_write_level()
  )
);

-- UPDATE: system admin or self (for properties only — clearance changes
-- require admin, but RLS can't distinguish which columns changed, so
-- the app layer must validate that non-admins only change properties)
CREATE POLICY actors_update ON actors
FOR UPDATE TO arke_app
USING (
  current_actor_is_admin()
  OR id = current_actor_id()
)
WITH CHECK (
  current_actor_is_admin()
  OR id = current_actor_id()
);

-- DELETE: only system admins
CREATE POLICY actors_delete ON actors
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
);


-- =============================================================================
-- SPACES
-- =============================================================================

ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;

-- SELECT: classification-gated
CREATE POLICY spaces_select ON spaces
FOR SELECT TO arke_app
USING (
  read_level = 0
  OR current_actor_read_level() >= read_level
);

-- INSERT: classification ceiling
CREATE POLICY spaces_insert ON spaces
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_write_level() >= write_level
  AND current_actor_read_level() >= read_level
);

-- UPDATE: classification ceiling + ACL (owner, editor/admin, system admin)
CREATE POLICY spaces_update ON spaces
FOR UPDATE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_space_role(id, ARRAY['editor', 'admin'])
  )
)
WITH CHECK (
  current_actor_write_level() >= write_level
);

-- DELETE: classification ceiling + admin ACL (owner, admin, system admin)
CREATE POLICY spaces_delete ON spaces
FOR DELETE TO arke_app
USING (
  current_actor_write_level() >= write_level
  AND (
    owner_id = current_actor_id()
    OR current_actor_is_admin()
    OR actor_has_space_role(id, ARRAY['admin'])
  )
);


-- =============================================================================
-- SPACE PERMISSIONS
-- =============================================================================

ALTER TABLE space_permissions ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent space is visible (classification-gated)
CREATE POLICY space_perms_select ON space_permissions
FOR SELECT TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND (s.read_level = 0 OR current_actor_read_level() >= s.read_level)
  )
);

-- Insert: must be owner or admin of the space
CREATE POLICY space_perms_insert ON space_permissions
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['admin'])
);

-- Update: must be owner or admin of the space (needed for ON CONFLICT DO UPDATE)
CREATE POLICY space_perms_update ON space_permissions
FOR UPDATE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['admin'])
);

-- Delete: must be owner or admin of the space
CREATE POLICY space_perms_delete ON space_permissions
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['admin'])
);


-- =============================================================================
-- SPACE ENTITIES
-- =============================================================================

ALTER TABLE space_entities ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent space is visible (classification-gated)
CREATE POLICY space_entities_select ON space_entities
FOR SELECT TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND (s.read_level = 0 OR current_actor_read_level() >= s.read_level)
  )
);

-- Insert: must be contributor+ on the space (owner, contributor, editor, admin)
CREATE POLICY space_entities_insert ON space_entities
FOR INSERT TO arke_app
WITH CHECK (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['contributor', 'editor', 'admin'])
);

-- Delete: must be editor+ on the space, or the one who added it
CREATE POLICY space_entities_delete ON space_entities
FOR DELETE TO arke_app
USING (
  current_actor_is_admin()
  OR added_by = current_actor_id()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND s.owner_id = current_actor_id()
  )
  OR actor_has_space_role(space_id, ARRAY['editor', 'admin'])
);


-- =============================================================================
-- AUTH TABLES
-- =============================================================================

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_keys ENABLE ROW LEVEL SECURITY;

-- API keys: permissive reads (middleware reads by hash before knowing actor)
CREATE POLICY api_keys_select ON api_keys
FOR SELECT TO arke_app
USING (true);

-- Insert: own keys, keys for actors you own, or admin
CREATE POLICY api_keys_insert ON api_keys
FOR INSERT TO arke_app
WITH CHECK (
  actor_id = current_actor_id()
  OR current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM actors
    WHERE actors.id = api_keys.actor_id
    AND actors.owner_id = current_actor_id()
  )
);

-- Update (revoke): own keys or admin
CREATE POLICY api_keys_update ON api_keys
FOR UPDATE TO arke_app
USING (
  actor_id = current_actor_id()
  OR current_actor_is_admin()
);

-- Agent keys: public keys readable by anyone
CREATE POLICY agent_keys_select ON agent_keys
FOR SELECT TO arke_app
USING (true);

-- Insert: own keys or admin
CREATE POLICY agent_keys_insert ON agent_keys
FOR INSERT TO arke_app
WITH CHECK (
  actor_id = current_actor_id()
  OR current_actor_is_admin()
);


-- =============================================================================
-- ACTOR UPDATE GUARD (BEFORE UPDATE trigger)
-- =============================================================================
--
-- RLS on actors allows self-updates (id = current_actor_id()), but it cannot
-- distinguish WHICH columns changed. The app layer restricts non-admins to
-- updating only `properties`, but a direct SQL client or a future route bug
-- could bypass that. This trigger is the database-level safety net.
--
-- Rules for non-admin self-updates:
--   - properties, updated_at     — freely changeable
--   - max_read_level             — can only lower (self-demotion)
--   - max_write_level            — can only lower (self-demotion)
--   - is_admin                   — immutable
--   - can_publish_public         — immutable
--   - status                     — immutable
--   - kind                       — immutable
--   - owner_id                   — immutable
--
-- System admins and admin-updating-another-actor are unrestricted.
--
-- =============================================================================

CREATE OR REPLACE FUNCTION actor_update_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Admins are unrestricted
  IF current_actor_is_admin() THEN
    RETURN NEW;
  END IF;

  -- Only restrict self-updates by non-admins
  IF NEW.id <> current_actor_id() THEN
    RETURN NEW;
  END IF;

  -- Privilege columns: can only lower, never raise
  IF NEW.max_read_level > OLD.max_read_level THEN
    RAISE EXCEPTION 'non-admin actors cannot escalate max_read_level';
  END IF;

  IF NEW.max_write_level > OLD.max_write_level THEN
    RAISE EXCEPTION 'non-admin actors cannot escalate max_write_level';
  END IF;

  -- Immutable columns: cannot change at all
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION 'non-admin actors cannot change is_admin';
  END IF;

  IF NEW.can_publish_public IS DISTINCT FROM OLD.can_publish_public THEN
    RAISE EXCEPTION 'non-admin actors cannot change can_publish_public';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'non-admin actors cannot change status';
  END IF;

  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'non-admin actors cannot change kind';
  END IF;

  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'non-admin actors cannot change owner_id';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS actor_update_guard ON actors;
CREATE TRIGGER actor_update_guard
  BEFORE UPDATE ON actors
  FOR EACH ROW
  EXECUTE FUNCTION actor_update_guard();


-- =============================================================================
-- RELATIONSHIP CLASSIFICATION GUARD (BEFORE INSERT trigger)
-- =============================================================================
--
-- The relationship entity's classification must be at least as high as the
-- max of its source and target entities (the "inference attack" defense).
-- The app layer already sets GREATEST(src, tgt), but this trigger is the
-- database-level safety net against direct inserts or future route bugs.
--
-- On INSERT: reject if the relationship entity's read_level or write_level
-- is lower than either endpoint.
--
-- =============================================================================

CREATE OR REPLACE FUNCTION relationship_classification_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rel_read  INT;
  rel_write INT;
  max_read  INT;
  max_write INT;
BEGIN
  -- Get the relationship entity's classification
  SELECT read_level, write_level INTO rel_read, rel_write
  FROM entities WHERE id = NEW.id;

  -- Get the max classification of source and target
  SELECT
    GREATEST(src.read_level, tgt.read_level),
    GREATEST(src.write_level, tgt.write_level)
  INTO max_read, max_write
  FROM entities src, entities tgt
  WHERE src.id = NEW.source_id AND tgt.id = NEW.target_id;

  IF rel_read < max_read THEN
    RAISE EXCEPTION 'relationship read_level (%) must be >= max of source/target read_level (%)',
      rel_read, max_read;
  END IF;

  IF rel_write < max_write THEN
    RAISE EXCEPTION 'relationship write_level (%) must be >= max of source/target write_level (%)',
      rel_write, max_write;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relationship_classification_guard ON relationship_edges;
CREATE TRIGGER relationship_classification_guard
  BEFORE INSERT ON relationship_edges
  FOR EACH ROW
  EXECUTE FUNCTION relationship_classification_guard();
