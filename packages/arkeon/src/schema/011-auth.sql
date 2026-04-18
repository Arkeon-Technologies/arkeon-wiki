-- =============================================================================
-- Auth Tables
-- =============================================================================
--
-- Authentication via API keys.
--
-- Flow:
--   1. First start generates admin API key
--   2. Day-to-day: X-API-Key: ak_xxx or uk_xxx (also supports Authorization: ApiKey <key>)
--   3. Lost keys: generate new key
--
-- =============================================================================

-- API keys
CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,                             -- ULID
  key_prefix TEXT NOT NULL,                                -- first 8 chars for display
  key_hash   TEXT NOT NULL UNIQUE,                         -- SHA-256 hash of full key
  actor_id   TEXT NOT NULL REFERENCES actors(id),
  label      TEXT,                                         -- optional human-readable label
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ                                   -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_actor ON api_keys(actor_id);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO arke_app;
