-- =============================================================================
-- Row-Level Security Policies
-- =============================================================================
--
-- Single-tenant model: all authenticated actors have full access.
--
-- Session context (set by middleware per request):
--   app.actor_id — authenticated actor's ID
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
DROP POLICY IF EXISTS sea_select             ON space_entity_access;
DROP POLICY IF EXISTS sea_insert             ON space_entity_access;
DROP POLICY IF EXISTS sea_update             ON space_entity_access;
DROP POLICY IF EXISTS sea_delete             ON space_entity_access;
DROP POLICY IF EXISTS api_keys_select        ON api_keys;
DROP POLICY IF EXISTS api_keys_insert        ON api_keys;
DROP POLICY IF EXISTS api_keys_update        ON api_keys;

-- Drop legacy triggers and functions
DROP TRIGGER IF EXISTS actor_update_guard ON actors;
DROP TRIGGER IF EXISTS relationship_classification_guard ON relationship_edges;
DROP FUNCTION IF EXISTS actor_update_guard();
DROP FUNCTION IF EXISTS relationship_classification_guard();
DROP FUNCTION IF EXISTS actor_has_entity_role(TEXT, TEXT[]);
DROP FUNCTION IF EXISTS actor_has_space_role(TEXT, TEXT[]);
DROP FUNCTION IF EXISTS current_actor_read_level();
DROP FUNCTION IF EXISTS current_actor_write_level();
DROP FUNCTION IF EXISTS current_actor_is_admin();


-- =============================================================================
-- ENTITIES
-- =============================================================================

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY entities_select ON entities
FOR SELECT TO arke_app
USING (current_actor_id() IS NOT NULL);

CREATE POLICY entities_insert ON entities
FOR INSERT TO arke_app
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY entities_update ON entities
FOR UPDATE TO arke_app
USING (current_actor_id() IS NOT NULL)
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY entities_delete ON entities
FOR DELETE TO arke_app
USING (current_actor_id() IS NOT NULL);


-- =============================================================================
-- RELATIONSHIP EDGES
-- =============================================================================

ALTER TABLE relationship_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY edges_select ON relationship_edges
FOR SELECT TO arke_app
USING (current_actor_id() IS NOT NULL);

CREATE POLICY edges_insert ON relationship_edges
FOR INSERT TO arke_app
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY edges_delete ON relationship_edges
FOR DELETE TO arke_app
USING (current_actor_id() IS NOT NULL);


-- =============================================================================
-- ENTITY VERSIONS
-- =============================================================================

ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY versions_select ON entity_versions
FOR SELECT TO arke_app
USING (current_actor_id() IS NOT NULL);

CREATE POLICY versions_insert ON entity_versions
FOR INSERT TO arke_app
WITH CHECK (current_actor_id() IS NOT NULL);


-- =============================================================================
-- ACTORS
-- =============================================================================

ALTER TABLE actors ENABLE ROW LEVEL SECURITY;

CREATE POLICY actors_select ON actors
FOR SELECT TO arke_app
USING (true);

CREATE POLICY actors_insert ON actors
FOR INSERT TO arke_app
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY actors_update ON actors
FOR UPDATE TO arke_app
USING (current_actor_id() IS NOT NULL)
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY actors_delete ON actors
FOR DELETE TO arke_app
USING (current_actor_id() IS NOT NULL);


-- =============================================================================
-- SPACES
-- =============================================================================

ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY spaces_select ON spaces
FOR SELECT TO arke_app
USING (current_actor_id() IS NOT NULL);

CREATE POLICY spaces_insert ON spaces
FOR INSERT TO arke_app
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY spaces_update ON spaces
FOR UPDATE TO arke_app
USING (current_actor_id() IS NOT NULL)
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY spaces_delete ON spaces
FOR DELETE TO arke_app
USING (current_actor_id() IS NOT NULL);


-- =============================================================================
-- SPACE ENTITIES
-- =============================================================================

ALTER TABLE space_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY space_entities_select ON space_entities
FOR SELECT TO arke_app
USING (current_actor_id() IS NOT NULL);

CREATE POLICY space_entities_insert ON space_entities
FOR INSERT TO arke_app
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY space_entities_delete ON space_entities
FOR DELETE TO arke_app
USING (current_actor_id() IS NOT NULL);


-- =============================================================================
-- AUTH TABLES
-- =============================================================================

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_keys_select ON api_keys
FOR SELECT TO arke_app
USING (true);

CREATE POLICY api_keys_insert ON api_keys
FOR INSERT TO arke_app
WITH CHECK (current_actor_id() IS NOT NULL);

CREATE POLICY api_keys_update ON api_keys
FOR UPDATE TO arke_app
USING (current_actor_id() IS NOT NULL);
