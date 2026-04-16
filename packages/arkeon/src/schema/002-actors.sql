-- =============================================================================
-- Actors Table
-- =============================================================================
--
-- Actors are authenticated agents or users. They are separate from entities.
--
-- max_read_level:    highest classification the actor can read (0-4)
-- max_write_level:   highest classification the actor can write to (ceiling)
-- is_admin:          system-wide admin override, bypasses ACL checks at app layer
-- can_publish_public: can set entities/spaces to read_level = 0 (PUBLIC)
--
-- Classification levels (configurable per deployment, integer ordering matters):
--   0 = PUBLIC       — readable by anyone, including unauthenticated
--   1 = INTERNAL     — readable by any authenticated actor
--   2 = TEAM         — readable by actors with TEAM clearance or above
--   3 = CONFIDENTIAL — restricted to CONFIDENTIAL clearance or above
--   4 = RESTRICTED   — highly restricted
--
-- =============================================================================

CREATE TABLE actors (
  id                 TEXT PRIMARY KEY,                      -- ULID
  kind               TEXT NOT NULL DEFAULT 'agent',         -- 'agent' (reserved for future kinds)
  max_read_level     INT NOT NULL DEFAULT 1,               -- 0=PUBLIC .. 4=RESTRICTED
  max_write_level    INT NOT NULL DEFAULT 1,               -- ceiling for writes
  is_admin           BOOLEAN NOT NULL DEFAULT false,       -- system-wide override
  can_publish_public BOOLEAN NOT NULL DEFAULT false,       -- can set read_level = 0
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
