# Testing

## Unit tests

`packages/arkeon/test/unit/` — isolated tests for parsers and utilities (frontmatter parsing, markdown link extraction, search ranking).

## E2e tests

`packages/arkeon/test/e2e/` — spin up a real SQLite database + API in-process and exercise the full lifecycle: space registration, file watcher, sync, link resolution, entity CRUD, ripgrep-backed search, daemon lifecycle.

No running stack needed — each test creates a fresh SQLite database in a temp directory.

## Running

```bash
npm run typecheck -w packages/arkeon    # type checking
npm test -w packages/arkeon             # unit tests
npm run test:e2e -w packages/arkeon     # e2e tests
```
