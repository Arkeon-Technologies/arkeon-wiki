# Architecture

High-level map of the Arkeon codebase for contributors. For build rules,
bundling invariants, and migration idempotency requirements, see
`CLAUDE.md` at the repo root — this document covers the *what* and *why*
of the architecture, not the rules for working in it.

## Packages

```
packages/
  arkeon/       Main package (published as `arkeon-wiki` on npm)
                CLI, API server, schema, shared types
  explorer/     Browser SPA (private, not published)
                Vite + React + Tailwind, built into arkeon-wiki dist
```

Everything ships inside the `arkeon-wiki` npm tarball.

## Source layout (`packages/arkeon/src/`)

```
src/
  index.ts                CLI entry (commander wiring)
  cli/
    commands/             CLI command definitions
    lib/                  CLI helpers (auth, config, output)
  server/
    app.ts                Hono app factory, route mounting
    server.ts             Startup sequence, graceful shutdown
    routes/               Route handlers by domain
    middleware/           Auth, request context
    lib/                  Shared server utilities, schemas
                          (includes wiki-links, wiki-resolve for the
                          wiki pipeline)
  schema/
    *.sql                 Numbered migrations
    migrate.ts            In-process migration runner
  shared/                 Concepts + OpenAPI helpers shared between
                          CLI codegen and server
  generated/              Checked-in codegen outputs
                          (OpenAPI snapshot, CLI commands, bundled assets)
```

## Request lifecycle

```
HTTP request
  → Hono router
  → requestContextMiddleware (assigns request ID)
  → authMiddleware (validates API key, sets actor session vars)
  → route handler (Zod validation via @hono/zod-openapi)
  → Postgres (via node-postgres, with RLS enforced per-session)
  → JSON response
```

Meilisearch is called for `/search` endpoints. S3 (or local filesystem)
is called for file uploads/downloads.

## Startup sequence

`arkeon start` / `arkeon up` runs this in order:

1. Read and normalize env vars (`ARKEON_*` canonical, legacy fallbacks)
2. Create Hono app, generate OpenAPI spec
3. **ensureBootstrap()** — run migrations, seed admin actor
4. **ensureMeiliIndex()** — validate Meilisearch connection (if configured)
5. **serve()** — bind HTTP on port 8000 (configurable)
6. **startRetention()** — retention policy enforcement

Graceful shutdown drains in-flight work with a configurable timeout
(`DRAIN_TIMEOUT_MS`, default 320s), then force-exits.

## Explorer

The explorer is a React SPA built with Vite, served at `/explore`.
In local mode, the server auto-injects the admin API key into the HTML
so the explorer works without manual auth. In production, the key is
not injected.

## Self-documenting API

The API generates its own documentation from route definitions:
- `/openapi.json` — OpenAPI 3.1 spec
- `/llms.txt` — full reference optimized for LLM context windows
- `/help` — interactive discovery

See [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md) for the full design.
