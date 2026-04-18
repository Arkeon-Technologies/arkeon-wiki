-- =============================================================================
-- Database Roles, Extensions & Helper Functions
-- =============================================================================
--
-- Sets up the non-superuser application role (arke_app) that all API
-- requests run as. RLS policies are enforced on this role.
--
-- The migration itself runs as the database owner (superuser or equivalent).
-- The arke_app role gets CRUD on all tables but is subject to RLS.
--
-- =============================================================================

-- Create the application role (idempotent). The password is supplied by
-- migrate.js via the :'arke_app_password' template token, sourced from
-- the ARKE_APP_PASSWORD env var (default 'arke' for host-mode dev/CI).
-- The ALTER branch makes the migration rotation-safe: changing
-- ARKE_APP_PASSWORD and re-running migrate updates the role's password.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arke_app') THEN
    CREATE ROLE arke_app LOGIN PASSWORD :'arke_app_password';
  ELSE
    ALTER ROLE arke_app WITH LOGIN PASSWORD :'arke_app_password';
  END IF;
END $$;

-- Schema access
GRANT USAGE ON SCHEMA public TO arke_app;

-- Extensions
-- pg_trgm removed: search is now handled by Meilisearch sidecar

-- =============================================================================
-- Session Context Helper Functions
-- =============================================================================
--
-- Middleware sets per request via SET LOCAL:
--   app.actor_id — the authenticated actor's ID
--
-- =============================================================================

CREATE OR REPLACE FUNCTION current_actor_id() RETURNS TEXT AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_id', true), ''), NULL);
$$ LANGUAGE sql STABLE;
