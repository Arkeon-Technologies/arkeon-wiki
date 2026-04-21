# Architecture

High-level map of the arkeon-wiki codebase for contributors. For build rules,
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
    middleware/            Auth, request context
    lib/                  Shared server utilities
      workers/            Background workers (extract, draft)
      wiki-pipeline.ts    Link parsing, resolution, relationship diffing
      wiki-links.ts       [[...]] link syntax parser
      entity-resolve.ts   Meilisearch + LLM entity matching
      llm.ts              LLM client with multi-step config
      worker-config.ts    workers.yaml loader
      meilisearch.ts      Search index management
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
  -> Hono router
  -> requestContextMiddleware (assigns request ID)
  -> authMiddleware (validates API key, sets actor session vars)
  -> route handler (Zod validation via @hono/zod-openapi)
  -> Postgres (via node-postgres, with RLS enforced per-session)
  -> JSON response
```

Meilisearch is called for `/search` endpoints. Local filesystem (or S3)
is used for file storage.

## Startup sequence

`arkeon-wiki start` / `arkeon-wiki up` runs this in order:

1. Read and normalize env vars
2. Start embedded Postgres (or connect to external `DATABASE_URL`)
3. Run schema migrations in-process
4. Start Meilisearch (or connect to external `MEILI_URL`)
5. Create Hono app, generate OpenAPI spec
6. **ensureBootstrap()** — seed admin actor, configure Meilisearch index
7. **serve()** — bind HTTP on port 8000 (configurable)
8. **startExtractWorker()** — polls `source_extract_queue` for documents to extract
9. **startDraftWorker()** — polls `wiki_draft_queue` for placeholders to draft
10. **startRetention()** — retention policy enforcement

Graceful shutdown drains in-flight work, stops workers, then exits.

## Background workers

Two background workers poll Postgres queues:

- **Extract worker** — reads file entities, calls LLM to identify subjects, creates placeholder entities with `extracted_from` relationships. Idempotent on re-extraction.
- **Draft worker** — reads placeholder entities, gathers context (source content, inbound spans, nearby entities), calls LLM to draft wiki pages, submits via the wiki pipeline. Includes dedup/redirect for entities that already exist.

Both workers are gated on `isLlmConfigured()` — they skip silently if no LLM API key is set.

## Explorer

The explorer is a React SPA built with Vite, served at `/explore`.
In local mode, the server auto-injects the admin API key into the HTML
so the explorer works without manual auth.

## Self-documenting API

The API generates its own documentation from route definitions:
- `/openapi.json` — OpenAPI 3.1 spec
- `/llms.txt` — full reference optimized for LLM context windows
- `/help` — interactive discovery
