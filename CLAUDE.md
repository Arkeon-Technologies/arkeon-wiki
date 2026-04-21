# arkeon-wiki

Forked from `Arkeon-Technologies/arkeon` at the `wiki-rewrite` branch. Wiki-centric knowledge graph — diverged enough from core arkeon to be its own repo.

**Repo**: `Arkeon-Technologies/arkeon-wiki`

Two npm workspaces. Only one is published to npm.

- `packages/arkeon` — the main package, published as `arkeon-wiki` on npm. Contains the CLI binary (`arkeon-wiki`), the Hono API server, the database schema migrations, and shared TypeScript types. Single source tree under `src/`:
  - `src/index.ts` — CLI entry (commander wiring)
  - `src/cli/commands/**` + `src/cli/lib/**` — CLI commands and helpers
  - `src/server/**` — Hono API server (routes, middleware, wiki pipeline)
  - `src/schema/*.sql` + `src/schema/migrate.ts` — migrations and the in-process runner
  - `src/shared/**` — concept text and OpenAPI helpers shared between CLI codegen and the server
  - `src/generated/**` — checked-in codegen outputs (OpenAPI snapshot → CLI commands + bundled Genesis seed)
- `packages/explorer` — browser SPA built with Vite, not published. Built as part of the `arkeon-wiki` build (via `bundle-explorer`); the static output is copied into `packages/arkeon/dist/explorer/` so it ships inside the `arkeon-wiki` tarball.

## Quick Start

Arkeon runs as a single Node process that manages its own Postgres and Meilisearch. No Docker, no system services.

```bash
npm install
npx tsx packages/arkeon/src/index.ts start    # bring up the full stack
```

First run downloads a Meilisearch binary into `~/.arkeon-wiki/bin/` (one-time, ~100MB), initializes an embedded Postgres cluster in `~/.arkeon-wiki/data/postgres/`, runs migrations in-process, and starts the API on `http://localhost:8000`. The admin API key is generated on first start and printed to the console (and persisted in `~/.arkeon-wiki/secrets.json` for subsequent starts).

`Ctrl+C` drains gracefully. From another terminal: `arkeon-wiki status`, `arkeon-wiki stop`, `arkeon-wiki reset`.

State lives in `~/.arkeon-wiki/` by default (override with `ARKEON_WIKI_HOME`). `arkeon-wiki reset` wipes data but keeps secrets + binary; `arkeon-wiki reset --hard` wipes everything.

## Workspace Commands

```bash
npx tsx packages/arkeon/src/index.ts start   # Start the full local stack
npx tsx packages/arkeon/src/index.ts stop    # Stop it
npx tsx packages/arkeon/src/index.ts migrate # Run migrations without starting the API
npm run typecheck -w packages/arkeon         # Typecheck everything in one shot
npm test -w packages/arkeon                  # Unit tests (test/unit/**)
npm run test:e2e -w packages/arkeon          # API e2e tests (needs a running stack)
./scripts/test-local.sh                      # Full pre-push check: typecheck + unit + start + e2e
```

## Configuration

Local-mode defaults are fine out of the box — secrets are generated on first run. For advanced setups see `.env.example` for host-mode overrides:
- `DATABASE_URL` — point at an external Postgres instead of embedded
- `MEILI_URL` / `MEILI_MASTER_KEY` — point at an external Meilisearch
- `STORAGE_BACKEND=s3` — switch from local filesystem to S3/R2/MinIO
- `ARKEON_WIKI_HOME` — override the `~/.arkeon-wiki` state directory

## One package, one deps list

All of arkeon's server, CLI, schema, and shared code lives in `packages/arkeon/` as a single published package. There is no splitting between them — adding a dep means one line in `packages/arkeon/package.json`, nothing else. The deps on `@arkeon-technologies/{api,schema,shared}` are gone; those subtrees are regular `src/` directories now.

If you ever find yourself tempted to split a subtree out as its own published package, check first:
1. Does it have a genuinely external consumer (not just "we import it elsewhere in the monorepo")?
2. Does it need an independent release cadence?
3. Does it have a different runtime target (browser/Deno/etc.)?

If none apply, keep it under `packages/arkeon/src/`. The CLI/server split we had in 0.3.0 and 0.3.1 caused cascading packaging bugs (tsup followed the workspace symlink, bundled the entire server tree with transitive deps, and tripped CJS/ESM interop errors) and was reverted for exactly this reason.

## Do NOT bundle server code into the CLI

`packages/arkeon/tsup.config.ts` uses all defaults — no `noExternal`, no explicit `external` list. Tsup auto-externalizes everything in `package.json` `dependencies` and bundles the `src/` tree via relative imports. Do not override this.

Specifically: if you see the `arkeon` dist size balloon above ~3MB, or see AWS SDK chunks (`sso-oidc-*.js`) inlined in the output instead of as `import` references, something is mis-configured. The fix is almost always to remove a `noExternal` entry or to put a dep in `dependencies` where tsup can see it.

A healthy build produces:
- `dist/index.js` — ~200 KB CLI entry
- `dist/server-*.js` — ~500 KB lazy-loaded server chunk (split via dynamic import)
- `dist/chunk-*.js` — ~15 KB shared chunk
- `dist/explorer/` — ~500 KB Vite SPA
- `dist/schema/*.sql` — ~20 KB, 3 migration files
- Total: ~2.5-3 MB

## Fresh-install smoke testing

Before every release, manually verify the published tarball in a clean scratch directory. CI does NOT test this path — CI uses the monorepo dev flow via `tsx`, which never exercises a real `npm install`. Packaging bugs only surface in a real install cycle, which is how 0.3.0 and 0.3.1 shipped broken.

```bash
cd packages/arkeon && npm pack
cd /tmp && mkdir smoke && cd smoke
npm init -y
npm install /path/to/arkeon-<version>.tgz
ARKEON_WIKI_HOME=./state npx arkeon-wiki init
ARKEON_WIKI_HOME=./state npx arkeon-wiki up
ARKEON_WIKI_HOME=./state npx arkeon-wiki seed
ARKEON_WIKI_HOME=./state npx arkeon-wiki status
curl http://localhost:8000/health
curl http://localhost:8000/explore
ARKEON_WIKI_HOME=./state npx arkeon-wiki down
```

Do not skip this step.

## Lockfile hygiene after structural changes

If you add, remove, or restructure workspace packages, or change version specifiers in any `package.json`, always regenerate the lockfile from a clean state:

```bash
rm -rf node_modules packages/*/node_modules package-lock.json
npm install
```

Do NOT run `npm install` on top of an existing `node_modules` — npm will preserve the old hoist layout in the lockfile even when the new package.json would resolve differently. A stale lockfile can cause CI to place deps per-package instead of hoisted-to-root, breaking builds that depend on cross-workspace resolution.

## Do NOT add in-process rate limiting

We deliberately have no rate limiter. Do not propose adding a per-IP
token bucket, a path exemption list, or a middleware to throttle
requests. Rate limiting, when we need it, belongs at the edge
(Cloudflare / nginx in front of deployed instances) or as per-actor
database quotas, not in-process.

## Documentation Principles

Docs are organized into `docs/user/` (for people running Arkeon) and
`docs/dev/` (for contributors and API consumers).

All docs are for information that is **not derivable from reading the code**:
- **Why**: Design rationale, trade-offs, architectural decisions
- **How things interact**: Cross-cutting behavior spanning multiple packages/services
- **Conventions**: Client-side patterns not enforced by code (e.g., entity refs, `arke:` URIs)
- **Operational knowledge**: Failure modes, gotchas, recommended usage patterns

Docs should **never** contain: endpoint lists, schema definitions, config defaults, or command references that live in code, `package.json`, or `.env.example`. Use `/openapi.json`, `/help`, or read the source.

### Updating docs after feature work

After changes that rename concepts, remove/replace features, add features previously marked "future", or change how packages interact:

1. Run `/review-docs all` or `/review-docs <filename>` to compare docs against codebase
2. Delete docs about removed features
3. Move "future" docs to `docs/user/` or `docs/dev/` when the feature ships
4. Trim any section that just restates what the code already says
5. Update terminology, file paths, and column names to match current code
6. Grep remaining docs for stale references (`git grep` old table names, endpoints, etc.)

Pay special attention to changes that span multiple services (e.g., renaming "commons" to "spaces" touched schema, routes, and 8 docs). These are the hardest to discover later.

## Schema Migrations

Migrations in `packages/arkeon/src/schema/` run on every deploy — there is no migration state tracker, so **every migration must be idempotent**. A migration that worked once will run again on the next deploy and must not fail.

Rules:
- `CREATE TABLE` / `CREATE INDEX` — always use `IF NOT EXISTS`
- `INSERT` seed data — always use `ON CONFLICT ... DO NOTHING` (or `DO UPDATE` if the seed should evolve)
- `ALTER TABLE ADD COLUMN` — wrap in a `DO $$ ... IF NOT EXISTS` check, or use `ADD COLUMN IF NOT EXISTS` (PG 9.6+)
- `ALTER TABLE DROP COLUMN` / `DROP CONSTRAINT` — always use `IF EXISTS`
- `DROP TABLE` / `DROP INDEX` — always use `IF EXISTS`
- Never assume a previous migration's intermediate state still exists (e.g., a constraint created in migration N may already be dropped by migration N+3)
- Test migrations by running `arkeon-wiki migrate` twice in a row — the second run must succeed cleanly
- Do not use loadable extensions (`CREATE EXTENSION`). The local stack uses embedded Postgres which does not ship extensions beyond what's built-in. Retention jobs that used to live in `pg_cron` now run in-process via `packages/arkeon/src/server/lib/retention.ts` — follow that pattern for new periodic tasks.

The migration runner itself lives at `packages/arkeon/src/schema/migrate.ts`. It exports `runMigrations({ databaseUrl, arkeAppPassword })` and is imported directly by `arkeon-wiki start` — no child process, no spawn, no top-level-await script.

## Agent Experience (AX) Surfaces

Arkeon has multiple self-documenting surfaces that agents and users rely on to discover and use the API. Every feature an agent might use **must be discoverable** via at least one of: `/llms.txt`, `arkeon-wiki docs`, or a skill body. If you ship a feature and no AX surface knows about it, it doesn't exist to agents.

The AX surfaces are documented inline below.

### Quick surface map

| What changed | AX surfaces affected | Action needed |
|---|---|---|
| **Route added/modified/removed** | `/llms.txt`, `/help`, `/openapi.json`, CLI commands, `arkeon-wiki docs` | Update `createRoute()` + Zod schemas, then rebuild (see checklist below) |
| **Concept changed** (core definitions, classification, best practices) | API guide, CLI guide | Edit `src/shared/concepts.ts` — propagates automatically |
| **Skill changed** (connect, doctor protocols) | Claude Code skills | Edit `assets/skills/meta.yaml` or `body/*.md`, rebuild to regenerate `src/generated/assets.ts` |
| **Guide content** (getting-started, admin) | `/help/guide`, `arkeon-wiki guide` | Edit `help.ts` (API) or `guide/index.ts` (CLI) |
| **Explorer** | `/explore` browser SPA | Edit `packages/explorer/`, rebuild |

### Checklist for route changes

**When adding, modifying, or removing routes, you MUST update the route's `createRoute()` definition and Zod schemas.** OpenAPI is generated at runtime from the route definitions and powers all of:
- `/openapi.json`
- `/llms.txt`
- `/help/:method/:path`
- `arkeon-wiki docs --format api`
- Auto-generated CLI commands

Steps:
- Define or update the route with `createRoute()` in the route file
- Reuse shared schemas from `packages/arkeon/src/server/lib/schemas.ts` when possible
- Include `operationId`, `tags`, `summary`, `x-arke-auth`, `x-arke-related`, and `x-arke-rules`
- `x-arke-rules` is an array of strings describing permission/authorization rules for the route
  - Write from the caller's perspective ("Requires...", "Only...", "Cannot...")
  - Cover both app-layer checks and RLS-layer enforcement
  - Do not duplicate info already in `x-arke-auth` (e.g. don't say "authentication required")
  - Use empty array `[]` for routes with no authorization rules beyond basic auth
- Use OpenAPI path params like `/{id}` in route metadata
- Keep summaries concise; put detail in parameter descriptions and schema descriptions
- Make request and response schemas accurate enough for CLI codegen and `/help` rendering
- **Regenerate CLI commands**: after any route change, run `npm run build -w packages/arkeon` and commit the updated `spec/openapi.snapshot.json`, `src/generated/index.ts`, and `src/generated/assets.ts`. This works offline — `fetch-spec` imports `app.ts` directly, no running server needed. CI (`check-cli-spec-drift`) will fail if these files are stale.

### AX review habit

After any feature work, ask: "Can an agent discover and use this?" Specifically:
1. If it's an API operation — is it in the OpenAPI spec with good descriptions and `x-arke-rules`?
2. If it's a workflow — is it in a skill body or guide?
3. If it's a concept — is it in `concepts.ts`?
4. If it's a CLI-only feature — does `arkeon-wiki docs --format cli` show it?
5. Rebuild and verify: `npm run build -w packages/arkeon`

## Publishing to npm

Publishing is automated via GitHub Actions (`.github/workflows/publish.yml`) and triggered by **GitHub Releases with a specific tag prefix**:

- `arkeon-wiki-v<version>` → publishes `arkeon-wiki` to npm (e.g., `arkeon-wiki-v0.1.0`)

Tags like `v0.1.0` (without the `arkeon-wiki-` prefix) will NOT trigger a publish. The workflow uses npm trusted publishing (OIDC) — no token needed.

### Release checklist

1. Bump `version` in `packages/arkeon/package.json`
2. Commit and push to main
3. Create a GitHub release with the correct tag prefix:
   ```bash
   gh release create arkeon-wiki-v0.1.0 --title "arkeon-wiki v0.1.0" --generate-notes
   ```
4. The publish workflow runs automatically — check Actions to confirm
5. Verify on npm: `npm view arkeon-wiki version`

Do NOT create releases with bare `v*` tags — they won't publish.
