-- =============================================================================
-- Space Entity Access: cascading permissions from spaces to contained entities
-- =============================================================================
--
-- A grant in space_entity_access means: "this actor/group can edit/admin
-- any entity that belongs to this space."  Removing the entity from the
-- space implicitly revokes the cascaded access.
--
-- This is separate from space_permissions, which controls who can manage
-- the space itself (add/remove entities, edit metadata, etc.).
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------

CREATE TABLE space_entity_access (
  space_id     TEXT        NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  grantee_type TEXT        NOT NULL DEFAULT 'actor',
  grantee_id   TEXT        NOT NULL,
  role         TEXT        NOT NULL,            -- 'editor' | 'admin'
  granted_by   TEXT        NOT NULL REFERENCES actors(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (space_id, grantee_type, grantee_id),
  CONSTRAINT sea_valid_grantee_type CHECK (grantee_type = 'actor'),
  CONSTRAINT sea_valid_role         CHECK (role IN ('editor', 'admin'))
);


GRANT SELECT, INSERT, UPDATE, DELETE ON space_entity_access TO arke_app;


-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Reverse lookup: given a grantee, find which spaces they have entity access on
CREATE INDEX idx_space_entity_access_grantee ON space_entity_access(grantee_id);

-- Reverse lookup on space_entities: given an entity, find which spaces it's in
-- (PK is (space_id, entity_id) — this index covers the entity_id → space_id direction)
CREATE INDEX IF NOT EXISTS idx_space_entities_entity_id ON space_entities(entity_id);


-- -----------------------------------------------------------------------------
-- RLS (same pattern as space_permissions)
-- -----------------------------------------------------------------------------

ALTER TABLE space_entity_access ENABLE ROW LEVEL SECURITY;

-- SELECT: visible if the parent space is readable
CREATE POLICY sea_select ON space_entity_access
FOR SELECT TO arke_app
USING (
  current_actor_is_admin()
  OR EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.id = space_id
    AND (s.read_level = 0 OR current_actor_read_level() >= s.read_level)
  )
);

-- INSERT: must be owner or admin of the space
CREATE POLICY sea_insert ON space_entity_access
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

-- UPDATE: must be owner or admin of the space (needed for ON CONFLICT DO UPDATE)
CREATE POLICY sea_update ON space_entity_access
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

-- DELETE: must be owner or admin of the space
CREATE POLICY sea_delete ON space_entity_access
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


-- -----------------------------------------------------------------------------
-- Update actor_has_entity_role() to include space-cascaded grants
-- -----------------------------------------------------------------------------
--
-- Previously checked: direct entity_permissions (actor or group grant).
-- Now also checks: is the entity in a space where the actor has entity-access?
--

CREATE OR REPLACE FUNCTION actor_has_entity_role(
  p_entity_id TEXT,
  p_roles TEXT[]
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    -- Direct entity permission
    SELECT 1 FROM entity_permissions ep
    WHERE ep.entity_id = p_entity_id
      AND ep.role = ANY(p_roles)
      AND ep.grantee_type = 'actor'
      AND ep.grantee_id = current_actor_id()
  )
  OR EXISTS (
    -- Space-cascaded entity access
    SELECT 1 FROM space_entities se
    JOIN space_entity_access sea ON sea.space_id = se.space_id
    WHERE se.entity_id = p_entity_id
      AND sea.role = ANY(p_roles)
      AND sea.grantee_type = 'actor'
      AND sea.grantee_id = current_actor_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;
