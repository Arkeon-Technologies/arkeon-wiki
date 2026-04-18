# Testing

Two levels: end-to-end API tests with Vitest, and opt-in stress scripts.

## E2E Test Layout

`packages/arkeon/test/e2e/` — functional suite split by domain. Read the directory listing for the current set; common coverage includes bootstrap/health, actors, wiki CRUD, spaces, and CLI smoke tests.

## Stress Scripts

`packages/arkeon/test/stress/` — manual operational checks, not part of Vitest:

- `auth.mjs` — auth flows under concurrency with retry/backoff
- `mutations.mjs` — repeated authenticated wiki creation
- `search-scale.mjs` — search indexing and query load testing
