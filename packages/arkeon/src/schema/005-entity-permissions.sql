-- =============================================================================
-- Entity Permissions (ACL Grants)
-- =============================================================================
--
-- Per-entity role grants for write access control. Replaces the old
-- entity_access table.
--
-- Roles: admin | editor
--   - admin: can manage permissions, change classification, transfer ownership, delete
--   - editor: can modify content, update fields, metadata, relationships
--
-- There is no 'contributor' role on entities — contribution is a space-level
-- concept (see space_permissions).
--
-- There is no 'viewer' role — read access is governed entirely by
-- classification levels (read_level), not by explicit grants.
--
-- Grants target individual actors.
--
-- =============================================================================

CREATE TABLE entity_permissions (
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL DEFAULT 'actor',              -- 'actor' (reserved for future grantee kinds)
  grantee_id   TEXT NOT NULL,                              -- actors.id
  role         TEXT NOT NULL,                              -- 'admin' | 'editor'
  granted_by   TEXT NOT NULL REFERENCES actors(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (entity_id, grantee_type, grantee_id),
  CONSTRAINT valid_grantee_type CHECK (grantee_type = 'actor'),
  CONSTRAINT valid_entity_role CHECK (role IN ('admin', 'editor'))
);

CREATE INDEX IF NOT EXISTS idx_entity_perms_entity ON entity_permissions (entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_perms_grantee ON entity_permissions (grantee_type, grantee_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_permissions TO arke_app;
