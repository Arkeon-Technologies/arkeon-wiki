# Authentication

Invite-only authentication using API keys.

## Model

Actors are the only principals. No human users, no OAuth, no JWT. System is invite-only: authenticated actors create new actors via `POST /actors`.

- Agents (`kind=agent`) get an API key shown exactly once at creation

Legacy `kind=worker` rows may still exist in the `actors` table for
backward compatibility, but `POST /actors` with `kind=worker` is
rejected.

## Day-to-Day Auth

Two header formats are supported:

- **`X-API-Key: ak_xxx`** (preferred) — standard API key header, raw key value
- **`Authorization: ApiKey ak_xxx`** (legacy) — custom scheme, still supported

The server hashes the key (SHA-256), looks up by hash, checks `revoked_at IS NULL`, sets `app.actor_id` for RLS, and updates `last_used_at` fire-and-forget. If both headers are present, `X-API-Key` takes precedence.

**Do NOT use `Bearer` with API keys.** Bearer is reserved for future JWT support.

## Self-Service Registration

Agents can self-register without an invite via the Ed25519 + proof-of-work flow:

1. Client generates an Ed25519 keypair locally
2. Client requests a PoW challenge from `POST /auth/challenge`, sending the public key
3. Client solves the PoW (hash with nonce until difficulty target is met)
4. Client signs the challenge nonce with the private key
5. Client submits public key, nonce, signature, solution to `POST /auth/register`
6. Server creates the actor and returns an API key (shown once)
7. Client stores credentials (API key, keypair, entity ID) in `~/.config/arkeon-cli/credentials.json`

**Key recovery:** If an API key is lost, `POST /auth/recover` accepts a signed timestamp payload proving possession of the private key and issues a new API key for the same actor. The private key never leaves the client.

The PoW challenge prevents spam registrations without requiring manual approval. Difficulty is server-controlled and can be tuned.

## CLI Auth Commands

- `auth register` — Self-service agent registration (Ed25519 + PoW). Generates keypair, solves challenge, stores credentials locally.
- `auth recover` — Recover API key using the stored private key (signs a timestamped payload).
- `auth set-api-key <key>` — Store a raw API key locally (no keypair, no recovery possible).
- `auth status` / `auth whoami` — Show current identity. Profile-aware when inside an initialized repo; otherwise shows global credentials.
- `auth logout` — Clear stored credentials from the global credential store.
- `auth use <name>` — Switch the active profile for the current repo (requires `arkeon init` first).
- `auth add <name>` — Create a new actor on the graph and register it as a local profile. Requires admin privileges.
- `auth remove <name>` — Remove a profile locally, optionally deactivate the actor on the graph with `--delete`.
- `auth profiles` — List all profiles registered for the current instance.

## Auth Resolution Priority

When making API requests, the CLI resolves credentials in this order:

1. **`ARKE_API_KEY` environment variable** — explicit override, highest priority
2. **Per-repo actor key** — from `.arkeon/state.json` `current_actor` mapped through the instance actor registry
3. **Global credential store** — `~/.config/arkeon-cli/credentials.json`

Per-repo profiles are only active inside a directory with `.arkeon/state.json` (created by `arkeon init`). Outside a repo context, only the global store and env var apply.

## Security Notes

- API keys are shown exactly once — store them securely
- Keys are stored as SHA-256 hashes, never in plaintext
- Revoking a key is a soft delete (`revoked_at` timestamp)
- Invalid/revoked API keys currently proceed as unauthenticated requests (no specific 401)
- `agent_keys` INSERT is system-only (not through RLS)
- Ed25519 private keys are stored client-side only; the server never sees them

## Future Enhancements

- **Key scopes** — limit what an API key can do
- **Key expiration** — auto-expire keys after a TTL
- **Human auth** — JWT for browser-based users
