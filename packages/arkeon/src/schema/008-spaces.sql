-- =============================================================================
-- Spaces, Space Permissions & Space-Entity Membership
-- =============================================================================
--
-- A space is a curated collection of entities. Spaces are NOT entities —
-- they are a separate table with their own permissions.
--
-- An entity can belong to multiple spaces (via space_entities join table).
-- The space is a lens/collection — it does not override entity-level
-- permissions. When querying a space, entities are further filtered by their
-- own read_level.
--
-- Spaces have three role types:
--   admin       — manage permissions, classification, delete space
--   editor      — modify space metadata, remove entities from space
--   contributor — add entities to space
--
-- =============================================================================

CREATE TABLE spaces (
  id               TEXT PRIMARY KEY,                       -- ULID
  name             TEXT NOT NULL,
  description      TEXT,
  owner_id         TEXT NOT NULL REFERENCES actors(id),    -- implicit Admin
  read_level       INT NOT NULL DEFAULT 1,                 -- min clearance to see this space
  write_level      INT NOT NULL DEFAULT 1,                 -- min clearance to edit space metadata
  status           TEXT NOT NULL DEFAULT 'active',         -- active | archived | deleted
  entity_count     INTEGER NOT NULL DEFAULT 0,             -- denormalized counter
  last_activity_at TIMESTAMPTZ,                            -- last entity added/removed
  properties       JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_space_status CHECK (status IN ('active', 'archived', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces (owner_id);
CREATE INDEX IF NOT EXISTS idx_spaces_read_level ON spaces (read_level);
CREATE INDEX IF NOT EXISTS idx_spaces_last_activity ON spaces (last_activity_at DESC NULLS LAST);

-- =============================================================================
-- Space Permissions
-- =============================================================================

CREATE TABLE space_permissions (
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL DEFAULT 'actor',              -- 'actor' (reserved for future grantee kinds)
  grantee_id   TEXT NOT NULL,                              -- actors.id
  role         TEXT NOT NULL,                              -- admin | editor | contributor
  granted_by   TEXT NOT NULL REFERENCES actors(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (space_id, grantee_type, grantee_id),
  CONSTRAINT valid_grantee_type CHECK (grantee_type = 'actor'),
  CONSTRAINT valid_space_role CHECK (role IN ('admin', 'editor', 'contributor'))
);

CREATE INDEX IF NOT EXISTS idx_space_perms_space ON space_permissions (space_id);
CREATE INDEX IF NOT EXISTS idx_space_perms_grantee ON space_permissions (grantee_type, grantee_id);

-- =============================================================================
-- Space-Entity Membership (join table)
-- =============================================================================

CREATE TABLE space_entities (
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  added_by   TEXT NOT NULL REFERENCES actors(id),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (space_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_space_entities_entity ON space_entities (entity_id);

-- =============================================================================
-- Trigger: maintain entity_count and last_activity_at on spaces
-- =============================================================================

CREATE OR REPLACE FUNCTION update_space_stats() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE spaces
    SET entity_count = entity_count + 1,
        last_activity_at = NOW()
    WHERE id = NEW.space_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE spaces
    SET entity_count = GREATEST(entity_count - 1, 0),
        last_activity_at = NOW()
    WHERE id = OLD.space_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_space_stats
AFTER INSERT OR DELETE ON space_entities
FOR EACH ROW EXECUTE FUNCTION update_space_stats();

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON spaces TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON space_permissions TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON space_entities TO arke_app;
