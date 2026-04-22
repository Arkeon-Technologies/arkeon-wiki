# Testing

## Unit tests

`packages/arkeon/test/unit/` — isolated tests for parsers and utilities.

## E2e tests

`packages/arkeon/test/e2e/` — spin up a real embedded Postgres + API in-process and exercise the full lifecycle: space registration, file watcher, sync, link resolution, entity CRUD.

No running stack needed — the tests manage their own Postgres instance on a non-conflicting port.

## Running

```bash
npm run typecheck -w packages/arkeon    # type checking
npm test -w packages/arkeon             # unit tests
npm run test:e2e -w packages/arkeon     # e2e tests
```
