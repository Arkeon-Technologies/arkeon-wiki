-- =============================================================================
-- Foundation: Roles, Session Context, Actors, Auth, Config
-- =============================================================================

-- Application role (idempotent). Password supplied via :'arke_app_password'
-- template token from migrate.ts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arke_app') THEN
    CREATE ROLE arke_app LOGIN PASSWORD :'arke_app_password';
  ELSE
    ALTER ROLE arke_app WITH LOGIN PASSWORD :'arke_app_password';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO arke_app;

-- Session context helper. Middleware sets per request via SET LOCAL.
CREATE OR REPLACE FUNCTION current_actor_id() RETURNS TEXT AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_id', true), ''), NULL);
$$ LANGUAGE sql STABLE;


-- =============================================================================
-- Actors
-- =============================================================================

CREATE TABLE IF NOT EXISTS actors (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL DEFAULT 'agent',
  owner_id           TEXT REFERENCES actors(id),
  properties         JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_actor_kind CHECK (kind = 'agent'),
  CONSTRAINT valid_actor_status CHECK (status IN ('active', 'suspended', 'deactivated'))
);

CREATE INDEX IF NOT EXISTS idx_actors_owner ON actors (owner_id);
CREATE INDEX IF NOT EXISTS idx_actors_status ON actors (status);

GRANT SELECT, INSERT, UPDATE, DELETE ON actors TO arke_app;


-- =============================================================================
-- API Keys
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  actor_id   TEXT NOT NULL REFERENCES actors(id),
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_actor ON api_keys(actor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO arke_app;


-- =============================================================================
-- System Config
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON system_config TO arke_app;
