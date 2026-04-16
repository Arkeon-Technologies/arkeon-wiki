# Testing

Three levels: schema tests in Postgres, end-to-end API tests with Vitest, and opt-in stress scripts.

## E2E Test Layout

`packages/arkeon/test/e2e/` — functional suite split by domain. Read the directory listing for the current set; common coverage includes bootstrap/health, actors, classification-based access control, entity CRUD, entity permissions, groups, spaces, ops, and CLI smoke tests.

## Stress Scripts

`packages/arkeon/test/stress/` — manual operational checks, not part of Vitest:

- `auth.mjs` — auth flows under concurrency with retry/backoff
- `mutations.mjs` — repeated authenticated entity creation
- `search-scale.mjs` — search indexing and query load testing

## Schema Tests

Direct schema/RLS validation against Postgres:

```bash
psql "$DATABASE_URL" -f packages/arkeon/src/schema/tests/run_tests.sql
```
