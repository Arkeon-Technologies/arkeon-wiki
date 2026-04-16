-- =============================================================================
-- 043: Drop platform surface (wiki-first rewrite)
-- =============================================================================
--
-- Retires the platform-layer tables that are not part of the wiki product:
--   * arkes (multi-tenant roots)
--   * workers + invocations (the runtime)
--   * knowledge pipeline (extraction/ingestion)
--   * groups + memberships (collaboration tier)
--   * comments, notifications, entity_activity (social surface)
--
-- Fresh installs never create these tables — the migration files that
-- used to do so have been deleted from src/schema/. This file is
-- IF EXISTS throughout so it's a no-op on fresh installs and a cleanup
-- on upgraders.
--
-- Data loss: YES. Any knowledge jobs, invocations, comments,
-- notifications, groups, or arkes on existing deployments are
-- permanently deleted. This is a breaking change and is documented as
-- such in the release notes.
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Drop tables (CASCADE clears dependent policies, triggers, constraints)
-- -----------------------------------------------------------------------------

-- Knowledge pipeline
DROP TABLE IF EXISTS knowledge_job_logs       CASCADE;
DROP TABLE IF EXISTS knowledge_token_usage    CASCADE;
DROP TABLE IF EXISTS knowledge_poller_state   CASCADE;
DROP TABLE IF EXISTS knowledge_jobs           CASCADE;
DROP TABLE IF EXISTS extraction_config        CASCADE;
DROP TABLE IF EXISTS knowledge_config         CASCADE;

-- Workers + invocations (drop dependents first)
DROP TABLE IF EXISTS worker_invocations       CASCADE;
DROP TABLE IF EXISTS worker_permissions       CASCADE;
DROP TABLE IF EXISTS workers                  CASCADE;

-- Social surface
DROP TABLE IF EXISTS comments                 CASCADE;
DROP TABLE IF EXISTS notifications            CASCADE;
DROP TABLE IF EXISTS entity_activity          CASCADE;

-- Groups
DROP TABLE IF EXISTS group_memberships        CASCADE;
DROP TABLE IF EXISTS groups                   CASCADE;

-- Arkes (multi-tenant roots) + membership table
DROP TABLE IF EXISTS actor_arke_membership    CASCADE;
DROP TABLE IF EXISTS arkes                    CASCADE;


-- -----------------------------------------------------------------------------
-- 2. Drop functions and triggers that referenced dropped tables
-- -----------------------------------------------------------------------------

-- Group-specific helpers
DROP FUNCTION IF EXISTS group_read_level(TEXT)                CASCADE;
DROP FUNCTION IF EXISTS last_group_admin_guard()              CASCADE;
DROP FUNCTION IF EXISTS last_group_admin_demote_guard()       CASCADE;

-- Worker-specific helpers
DROP FUNCTION IF EXISTS actor_has_worker_role(TEXT, TEXT[])   CASCADE;

-- Activity notify trigger function (used by entity_activity only)
DROP FUNCTION IF EXISTS notify_activity()                     CASCADE;


-- -----------------------------------------------------------------------------
-- 3. Scrub leftover group/worker grants on kept tables
-- -----------------------------------------------------------------------------

-- entity_permissions may have grantee_type='group' rows. Remove them
-- before tightening the CHECK constraint.
DELETE FROM entity_permissions       WHERE grantee_type <> 'actor';
DELETE FROM space_entity_access      WHERE grantee_type <> 'actor';
DELETE FROM space_permissions        WHERE grantee_type <> 'actor';


-- -----------------------------------------------------------------------------
-- 4. Tighten grantee_type CHECK constraints to actor-only
-- -----------------------------------------------------------------------------

ALTER TABLE entity_permissions
  DROP CONSTRAINT IF EXISTS valid_grantee_type;

ALTER TABLE entity_permissions
  ADD CONSTRAINT valid_grantee_type CHECK (grantee_type = 'actor');

ALTER TABLE space_entity_access
  DROP CONSTRAINT IF EXISTS sea_valid_grantee_type;

ALTER TABLE space_entity_access
  ADD CONSTRAINT sea_valid_grantee_type CHECK (grantee_type = 'actor');

ALTER TABLE space_permissions
  DROP CONSTRAINT IF EXISTS valid_grantee_type;

ALTER TABLE space_permissions
  ADD CONSTRAINT valid_grantee_type CHECK (grantee_type = 'actor');


-- -----------------------------------------------------------------------------
-- 5. Retire the 'worker' actor kind
-- -----------------------------------------------------------------------------

-- Admin context so actor_update_guard allows the kind change.
SELECT set_config('app.actor_id', 'MIGRATION', true);
SELECT set_config('app.actor_is_admin', 'true', true);

-- Delete worker-kind actors (they were runtime identities, not humans).
DELETE FROM actors WHERE kind = 'worker';

-- Tighten the actor kind constraint to agent-only.
ALTER TABLE actors
  DROP CONSTRAINT IF EXISTS valid_actor_kind;

ALTER TABLE actors
  ADD CONSTRAINT valid_actor_kind CHECK (kind = 'agent');
