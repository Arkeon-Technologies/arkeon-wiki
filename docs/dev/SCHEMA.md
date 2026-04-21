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
5. Test by running `arkeon-wiki migrate` twice — the second run must succeed

### Runner internals

`runMigrations()` in `migrate.ts` is called in-process by `arkeon-wiki start` —
no child process, no spawn. It connects as superuser, iterates SQL files,
applies template variables, splits statements, and executes them. Errors
with code `42P07` (already exists) or `42703` (column not found during
rename) are silently skipped for idempotency.

## Data model

The graph is built from a small set of core tables:

- **actors** — authenticated identities (agents with API keys).
- **entities** — knowledge graph nodes. Everything is an entity: documents,
  concepts, people, wikis, placeholders, files. Each has a semantic `type`
  and versioned `properties` (JSONB). The `kind` field distinguishes
  entity nodes (`kind='entity'`) from relationship edges (`kind='relationship'`).
- **relationship_edges** — graph structure. Each edge links a source entity
  to a target entity with a `predicate`. Edges are themselves entities
  (kind = `relationship`), so they carry their own properties and span text.
- **spaces** — curated entity collections with a join table (`space_entities`).
- **api_keys** — SHA-256 hashed authentication tokens.

Supporting tables:

- **entity_versions** — version history for entities (created on update)
- **entity_redirects** — maps old entity IDs to canonical IDs after dedup/merge
- **source_extract_queue** — tracks document extraction status (pending/processing/complete)
- **wiki_draft_queue** — tracks wiki drafting status with depth and deadline

## Entity creation paths

Entities are created through two main routes:

- **`POST /files`** — creates file entities (`type='file'`) from raw documents.
  Automatically enqueues for entity extraction.
- **`POST /wiki`** — creates wiki entities (`type='wiki'`). Runs the wiki
  pipeline: parses `[[...]]` links, resolves references, mints placeholders,
  creates/updates relationships.

The extraction worker creates placeholder entities (`type='placeholder'`)
from extracted subjects. The draft worker converts placeholders into wikis
by calling `POST /wiki` internally.

## Access control

All authenticated actors have full read/write access. Authentication is
via API key (`X-API-Key` header). Middleware sets session context via
`SET LOCAL` (`app.actor_id`) for audit tracking.
