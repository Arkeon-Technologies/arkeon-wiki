-- =============================================================================
-- Spaces, Wiki Draft Queue, and Row-Level Security
-- =============================================================================

-- =============================================================================
-- Spaces — curated entity collections
-- =============================================================================

CREATE TABLE IF NOT EXISTS spaces (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  owner_id         TEXT NOT NULL REFERENCES actors(id),
  status           TEXT NOT NULL DEFAULT 'active',
  entity_count     INTEGER NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  properties       JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_space_status CHECK (status IN ('active', 'archived'))
);

-- Migration: hard-delete any remaining soft-deleted spaces, then tighten the constraint
DELETE FROM spaces WHERE status = 'deleted';
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS valid_space_status;
ALTER TABLE spaces ADD CONSTRAINT valid_space_status CHECK (status IN ('active', 'archived'));

CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces (owner_id);
CREATE INDEX IF NOT EXISTS idx_spaces_last_activity ON spaces (last_activity_at DESC NULLS LAST);

-- =============================================================================
-- Space-Entity Membership
-- =============================================================================

CREATE TABLE IF NOT EXISTS space_entities (
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  added_by   TEXT NOT NULL REFERENCES actors(id),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (space_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_space_entities_entity ON space_entities (entity_id);

-- Trigger: maintain entity_count and last_activity_at on spaces
-- Only counts entities with kind='entity', not relationships.
-- On DELETE: the entity row may already be gone (CASCADE), so we check
-- whether it still exists as a relationship — if it's gone or was an
-- entity, we decrement.
CREATE OR REPLACE FUNCTION update_space_stats() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM entities WHERE id = NEW.entity_id AND kind = 'entity') THEN
      UPDATE spaces
      SET entity_count = entity_count + 1,
          last_activity_at = NOW()
      WHERE id = NEW.space_id;
    ELSE
      UPDATE spaces SET last_activity_at = NOW() WHERE id = NEW.space_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- If the entity is gone (CASCADE) or was kind='entity', decrement.
    -- Only skip decrement if the entity still exists AND is a relationship.
    IF NOT EXISTS (SELECT 1 FROM entities WHERE id = OLD.entity_id AND kind = 'relationship') THEN
      UPDATE spaces
      SET entity_count = GREATEST(entity_count - 1, 0),
          last_activity_at = NOW()
      WHERE id = OLD.space_id;
    ELSE
      UPDATE spaces SET last_activity_at = NOW() WHERE id = OLD.space_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_space_stats ON space_entities;
CREATE TRIGGER trg_space_stats
AFTER INSERT OR DELETE ON space_entities
FOR EACH ROW EXECUTE FUNCTION update_space_stats();

-- Repair existing entity_count values (recompute from actual entity-kind rows)
-- Two-part repair: update spaces that have entities, then zero out the rest
UPDATE spaces s
SET entity_count = sub.cnt
FROM (
  SELECT se.space_id, COUNT(*) AS cnt
  FROM space_entities se
  JOIN entities e ON e.id = se.entity_id AND e.kind = 'entity'
  GROUP BY se.space_id
) sub
WHERE s.id = sub.space_id AND s.entity_count != sub.cnt;

-- Zero out spaces that have no entity-kind members (only relationships or empty)
UPDATE spaces s
SET entity_count = 0
WHERE s.entity_count != 0
  AND NOT EXISTS (
    SELECT 1 FROM space_entities se
    JOIN entities e ON e.id = se.entity_id AND e.kind = 'entity'
    WHERE se.space_id = s.id
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON spaces TO arke_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON space_entities TO arke_app;


-- =============================================================================
-- Wiki Draft Queue
-- =============================================================================

CREATE TABLE IF NOT EXISTS wiki_draft_queue (
  entity_id    TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  depth        INTEGER NOT NULL DEFAULT 0,
  owner_agent  TEXT NOT NULL REFERENCES actors(id),
  deadline     TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','complete','failed','undraftable')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wiki_draft_queue_pending_idx
  ON wiki_draft_queue (created_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON wiki_draft_queue TO arke_app;


-- =============================================================================
-- Row-Level Security — single-tenant: all authenticated actors have full access
-- =============================================================================

-- Actors
ALTER TABLE actors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS actors_select ON actors;
CREATE POLICY actors_select ON actors
FOR SELECT TO arke_app USING (true);

DROP POLICY IF EXISTS actors_insert ON actors;
CREATE POLICY actors_insert ON actors
FOR INSERT TO arke_app WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS actors_update ON actors;
CREATE POLICY actors_update ON actors
FOR UPDATE TO arke_app
USING (current_actor_id() IS NOT NULL)
WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS actors_delete ON actors;
CREATE POLICY actors_delete ON actors
FOR DELETE TO arke_app USING (current_actor_id() IS NOT NULL);

-- Entities
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entities_select ON entities;
CREATE POLICY entities_select ON entities
FOR SELECT TO arke_app USING (true);

DROP POLICY IF EXISTS entities_insert ON entities;
CREATE POLICY entities_insert ON entities
FOR INSERT TO arke_app WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS entities_update ON entities;
CREATE POLICY entities_update ON entities
FOR UPDATE TO arke_app
USING (current_actor_id() IS NOT NULL)
WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS entities_delete ON entities;
CREATE POLICY entities_delete ON entities
FOR DELETE TO arke_app USING (current_actor_id() IS NOT NULL);

-- Relationship Edges
ALTER TABLE relationship_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS edges_select ON relationship_edges;
CREATE POLICY edges_select ON relationship_edges
FOR SELECT TO arke_app USING (true);

DROP POLICY IF EXISTS edges_insert ON relationship_edges;
CREATE POLICY edges_insert ON relationship_edges
FOR INSERT TO arke_app WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS edges_delete ON relationship_edges;
CREATE POLICY edges_delete ON relationship_edges
FOR DELETE TO arke_app USING (current_actor_id() IS NOT NULL);

-- Entity Versions
ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS versions_select ON entity_versions;
CREATE POLICY versions_select ON entity_versions
FOR SELECT TO arke_app USING (true);

DROP POLICY IF EXISTS versions_insert ON entity_versions;
CREATE POLICY versions_insert ON entity_versions
FOR INSERT TO arke_app WITH CHECK (current_actor_id() IS NOT NULL);

-- Entity Redirects
ALTER TABLE entity_redirects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS redirects_select ON entity_redirects;
CREATE POLICY redirects_select ON entity_redirects
FOR SELECT TO arke_app USING (true);

-- Spaces
ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS spaces_select ON spaces;
CREATE POLICY spaces_select ON spaces
FOR SELECT TO arke_app USING (true);

DROP POLICY IF EXISTS spaces_insert ON spaces;
CREATE POLICY spaces_insert ON spaces
FOR INSERT TO arke_app WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS spaces_update ON spaces;
CREATE POLICY spaces_update ON spaces
FOR UPDATE TO arke_app
USING (current_actor_id() IS NOT NULL)
WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS spaces_delete ON spaces;
CREATE POLICY spaces_delete ON spaces
FOR DELETE TO arke_app USING (current_actor_id() IS NOT NULL);

-- Space Entities
ALTER TABLE space_entities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS space_entities_select ON space_entities;
CREATE POLICY space_entities_select ON space_entities
FOR SELECT TO arke_app USING (true);

DROP POLICY IF EXISTS space_entities_insert ON space_entities;
CREATE POLICY space_entities_insert ON space_entities
FOR INSERT TO arke_app WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS space_entities_delete ON space_entities;
CREATE POLICY space_entities_delete ON space_entities
FOR DELETE TO arke_app USING (current_actor_id() IS NOT NULL);

-- API Keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_keys_select ON api_keys;
CREATE POLICY api_keys_select ON api_keys
FOR SELECT TO arke_app USING (true);

DROP POLICY IF EXISTS api_keys_insert ON api_keys;
CREATE POLICY api_keys_insert ON api_keys
FOR INSERT TO arke_app WITH CHECK (current_actor_id() IS NOT NULL);

DROP POLICY IF EXISTS api_keys_update ON api_keys;
CREATE POLICY api_keys_update ON api_keys
FOR UPDATE TO arke_app USING (current_actor_id() IS NOT NULL);
