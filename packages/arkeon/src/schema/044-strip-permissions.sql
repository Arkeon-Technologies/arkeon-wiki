-- =============================================================================
-- Strip Multi-Tenant Permissions
-- =============================================================================
--
-- Simplifies to single-tenant auth: one wiki, one admin, no classification
-- levels, no per-entity/space ACLs. All authenticated actors have full access.
--
-- Drops: classification columns, permission tables, RLS helper functions,
--        guard triggers. RLS policies are rewritten by 015-rls-policies.sql.
--
-- =============================================================================


-- =============================================================================
-- 1. Drop triggers (must happen before dropping their functions)
-- =============================================================================

DROP TRIGGER IF EXISTS actor_update_guard ON actors;
DROP TRIGGER IF EXISTS relationship_classification_guard ON relationship_edges;


-- =============================================================================
-- 2. Drop functions
-- =============================================================================

DROP FUNCTION IF EXISTS actor_update_guard();
DROP FUNCTION IF EXISTS relationship_classification_guard();
DROP FUNCTION IF EXISTS actor_has_entity_role(TEXT, TEXT[]);
DROP FUNCTION IF EXISTS actor_has_space_role(TEXT, TEXT[]);
DROP FUNCTION IF EXISTS current_actor_read_level();
DROP FUNCTION IF EXISTS current_actor_write_level();


-- =============================================================================
-- 3. Drop permission tables
-- =============================================================================

DROP TABLE IF EXISTS space_entity_access CASCADE;
DROP TABLE IF EXISTS entity_permissions CASCADE;
DROP TABLE IF EXISTS space_permissions CASCADE;


-- =============================================================================
-- 4. Drop classification columns
-- =============================================================================

ALTER TABLE actors DROP COLUMN IF EXISTS max_read_level;
ALTER TABLE actors DROP COLUMN IF EXISTS max_write_level;
ALTER TABLE actors DROP COLUMN IF EXISTS can_publish_public;

ALTER TABLE entities DROP COLUMN IF EXISTS read_level;
ALTER TABLE entities DROP COLUMN IF EXISTS write_level;

ALTER TABLE spaces DROP COLUMN IF EXISTS read_level;
ALTER TABLE spaces DROP COLUMN IF EXISTS write_level;

DROP INDEX IF EXISTS idx_entities_read_level;
DROP INDEX IF EXISTS idx_spaces_read_level;


-- =============================================================================
-- 5. Drop admin/agent_keys/entity_exists remnants
-- =============================================================================

DROP FUNCTION IF EXISTS current_actor_is_admin();
DROP FUNCTION IF EXISTS entity_exists(TEXT);
DROP TABLE IF EXISTS agent_keys CASCADE;
ALTER TABLE actors DROP COLUMN IF EXISTS is_admin;
