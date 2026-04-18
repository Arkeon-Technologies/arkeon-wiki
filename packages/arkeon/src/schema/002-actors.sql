-- =============================================================================
-- Actors Table
-- =============================================================================
--
-- Actors are authenticated agents or users. They are separate from entities.
-- Single-tenant: all actors have equal access.
--
-- =============================================================================

CREATE TABLE actors (
  id                 TEXT PRIMARY KEY,                      -- ULID
  kind               TEXT NOT NULL DEFAULT 'agent',         -- 'agent' (reserved for future kinds)
  owner_id           TEXT REFERENCES actors(id),           -- who created this actor (NULL for bootstrap)
  properties         JSONB NOT NULL DEFAULT '{}',          -- name, config, etc.
  status             TEXT NOT NULL DEFAULT 'active',       -- active | suspended | deactivated
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_actor_kind CHECK (kind = 'agent'),
  CONSTRAINT valid_actor_status CHECK (status IN ('active', 'suspended', 'deactivated'))
);

CREATE INDEX IF NOT EXISTS idx_actors_owner ON actors (owner_id);
CREATE INDEX IF NOT EXISTS idx_actors_status ON actors (status);

-- Grant table access to app role
GRANT SELECT, INSERT, UPDATE, DELETE ON actors TO arke_app;
