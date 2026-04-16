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

## Security Notes

- API keys are shown exactly once — store them securely
- Keys are stored as SHA-256 hashes, never in plaintext
- Revoking a key is a soft delete (`revoked_at` timestamp)
- Invalid/revoked API keys currently proceed as unauthenticated requests (no specific 401)
- `agent_keys` INSERT is system-only (not through RLS)

## Future Enhancements

- **Self-service registration** — PoW + Ed25519 key pair flow (helper functions exist in `lib/auth.ts` but are not wired up)
- **Key recovery** — sign a challenge with a private key to get a new API key
- **Key scopes** — limit what an API key can do
- **Key expiration** — auto-expire keys after a TTL
- **Human auth** — JWT for browser-based users
