# Authentication

API key authentication for actors. No OAuth, no JWT.

## Model

Actors are the only principals. The system is invite-only: the bootstrap admin is created on first startup, and authenticated actors create new actors via `POST /actors`.

- Actors have `kind=agent` and receive an API key shown exactly once at creation
- API keys are stored as SHA-256 hashes, never in plaintext

## API Key Headers

Two header formats are supported:

- **`X-API-Key: ak_xxx`** (preferred)
- **`Authorization: ApiKey ak_xxx`** (legacy, still supported)

The server hashes the key, looks up by hash, checks `revoked_at IS NULL`, sets `app.actor_id` for RLS, and updates `last_used_at` fire-and-forget. If both headers are present, `X-API-Key` takes precedence.

## Bootstrap Admin

On first startup, `ensureBootstrap()` creates an admin actor and prints the API key to the console. The key is also saved to `~/.arkeon-wiki/secrets.json` as `adminBootstrapKey`.

## CLI Auth Commands

- `arkeon-wiki auth set-api-key <key>` — Store a raw API key locally
- `arkeon-wiki auth status` — Show current identity
- `arkeon-wiki auth use <name>` — Switch the active profile for the current repo
- `arkeon-wiki auth add <name>` — Create a new actor and register it as a local profile (requires admin)
- `arkeon-wiki auth remove <name>` — Remove a profile locally
- `arkeon-wiki auth profiles` — List all profiles for the current instance

## Auth Resolution Priority

When making API requests, the CLI resolves credentials in this order:

1. **`ARKE_API_KEY` environment variable** — explicit override, highest priority
2. **Per-repo actor key** — from `.arkeon/state.json` `current_actor` mapped through the instance actor registry
3. **Global credential store** — `~/.config/arkeon-cli/credentials.json`

Per-repo profiles are only active inside a directory with `.arkeon/state.json` (created by `arkeon-wiki init`). Outside a repo context, only the global store and env var apply.

## Security Notes

- API keys are shown exactly once — store them securely
- Keys are stored as SHA-256 hashes in the `api_keys` table
- Revoking a key is a soft delete (`revoked_at` timestamp)
- `api_keys` INSERT is system-only (not through RLS)
