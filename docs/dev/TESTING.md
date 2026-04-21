# Testing

Two levels: end-to-end API tests with Vitest, and manual operational scripts.

## E2E Test Layout

`packages/arkeon/test/e2e/` — functional suite split by domain. Read the directory listing for the current set; common coverage includes bootstrap/health, actors, wiki CRUD, spaces, and CLI smoke tests.

## Unit Tests

`packages/arkeon/test/unit/` — isolated unit tests.

## Manual Scripts

`packages/arkeon/test/manual/` — operational checks, not part of Vitest:

- `search-scale.mjs` — search indexing and query load testing
- `wiki-resolve-seed.ts` — seed data for wiki resolution testing
- `wiki-resolve.test.ts` — wiki link resolution tests

## Running

```bash
npm run typecheck -w packages/arkeon   # type checking
npm test -w packages/arkeon            # unit tests
npm run test:e2e -w packages/arkeon    # e2e tests (needs running stack)
./scripts/test-local.sh               # full: typecheck + unit + start + e2e
```
