# Schema

Overview of the Postgres schema design and migration system. For column
definitions, read the SQL files directly in `packages/arkeon/src/schema/`.

## Migration system

Migrations live in `packages/arkeon/src/schema/` as numbered SQL files.
The runner (`migrate.ts`) executes them in order on every startup —
there is no migration state tracker.

**Every migration must be idempotent.** See CLAUDE.md for the full list
of idempotency rules. The short version: always use `IF NOT EXISTS` /
`IF EXISTS`, always use `ON CONFLICT` for seed data, never use
`CREATE EXTENSION`.

### Adding a new migration

1. Create `src/schema/NNN-descriptive-name.sql` (next number in sequence)
2. Follow the idempotency rules in CLAUDE.md
3. The runner splits on semicolons, handling dollar-quoted blocks (`$$`)
   and comments correctly
4. Template variable `:'arke_app_password'` is replaced at runtime
5. Test by running `arkeon migrate` twice — the second run must succeed

### Runner internals

`runMigrations()` in `migrate.ts` is called in-process by `arkeon start` —
no child process, no spawn. It connects as superuser, iterates SQL files,
applies template variables, splits statements, and executes them. Errors
with code `42P07` (already exists) or `42703` (column not found during
rename) are silently skipped for idempotency.

## Data model

The graph is built from a small set of core tables:

- **actors** — authenticated identities (agents with API keys). Each has
  classification ceilings that cap what they can read and write.
- **entities** — knowledge graph nodes. Everything is an entity: documents,
  concepts, people, relationships. Each has a semantic `type`, versioned
  `properties` (JSONB), and a classification level.
- **relationship_edges** — graph structure. Each edge links a source entity
  to a target entity with a `predicate`. Edges are themselves entities
  (kind = `relationship`), so they carry their own properties and permissions.
- **spaces** — curated entity collections. Each space has its own permission
  model (`space_permissions`) and a join table (`space_entities`).
- **api_keys** — SHA-256 hashed authentication tokens.
- **entity_permissions** — write ACL grants (admin, editor roles).
- **groups** / **group_memberships** — actor groups that can be grantees
  in permission tables.

Supporting tables handle versioning (`entity_versions`), audit logging
(`entity_activity`), comments, notifications, and the wiki draft queue
(used by the wiki pipeline).

## Access control

Two layers enforced by Postgres RLS:

1. **Classification levels (reads):** `actor.max_read_level >= entity.read_level`.
   Five tiers: 0 (PUBLIC) through 4 (RESTRICTED).
2. **ACL grants (writes):** Actor must have sufficient classification
   *and* an explicit grant (owner, admin, or editor) on the entity or
   its space.

Middleware sets session context via `SET LOCAL` (`app.actor_id`,
`app.actor_read_level`, etc.) and RLS policies reference these variables.
Admin actors bypass all policies.

Relationship visibility requires `max(source.read_level, target.read_level)`
to defend against inference attacks — you can't discover a RESTRICTED
entity's existence by reading its PUBLIC neighbor's edges.
