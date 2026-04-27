---
name: local-dev
description: Start the local development environment (SQLite + Hono API) and run e2e tests.
disable-model-invocation: true
argument-hint: [start|test|stop|status]
allowed-tools: Bash(npm *, npx *, curl *, pkill *, kill *, lsof *, ls *, cat *, mkdir *, rm *), Read, TaskOutput
---

# Local Development Environment

Manage the local dev daemon via the `arkeon-wiki` CLI. Everything runs as a single Node process — SQLite database and Hono API server. No Postgres, no Meilisearch, no Docker, no auth.

## Stack Management

### `start` (default)

Use `arkeon-wiki up` to start the daemon detached:

```bash
npx tsx packages/arkeon/src/index.ts up
```

This:
- Starts the Hono API server on port 8000 (default instance)
- Opens / creates the SQLite database at `~/.arkeon-wiki/data/arke.db`
- Runs idempotent schema migrations (`001-foundation.sql`)
- Spawns the file watcher for every registered space
- Detaches and writes a pidfile to `~/.arkeon-wiki/arkeon.pid`
- Polls `/health` until ready

For **named instances** (parallel daemons):

```bash
npx tsx packages/arkeon/src/index.ts up --name my-feature
```

Each named instance gets its own `ARKEON_WIKI_HOME` at `~/.arkeon-wiki/<name>/`, its own SQLite database, and a deterministic port (`8000 + sha256(name) mod 999 + 1`).

Check it's running:

```bash
npx tsx packages/arkeon/src/index.ts status
npx tsx packages/arkeon/src/index.ts ls       # list all running instances
```

Tail the daemon log:

```bash
npx tsx packages/arkeon/src/index.ts logs -f
```

### `stop`

```bash
npx tsx packages/arkeon/src/index.ts down [--name <name>]
```

Sends SIGTERM, waits for graceful shutdown, removes the pidfile and instance registry entry.

### `status`

```bash
npx tsx packages/arkeon/src/index.ts status
```

Shows: process state, health, port, state directory, and bound space (if invoked from an initialized directory).

## Worktree Isolation

**Each worktree should run its own named instance.** The CLI and server ship as a single package — there's no version negotiation, so running worktree B's CLI against worktree A's server will break if the branches have schema or API differences.

```bash
WORKTREE_NAME=$(basename "$PWD")
npx tsx packages/arkeon/src/index.ts up --name "$WORKTREE_NAME"
```

This gives each worktree:
- Its own `ARKEON_WIKI_HOME` at `~/.arkeon-wiki/<name>/` (SQLite database, pidfile, log)
- Its own deterministic port (no collisions with other worktrees)
- Its own entry in `~/.arkeon-wiki/instances/`

Always run `arkeon-wiki init` and other commands **from the same worktree** that started the instance.

The main checkout (not a worktree) uses the default instance: `~/.arkeon-wiki/`, port 8000.

## Repo Binding

After the daemon is running, register the current directory as a space:

```bash
cd /path/to/my-repo
npx tsx packages/arkeon/src/index.ts init
```

This creates:
- A space record in SQLite for the current directory
- `.arkeon/state.json` with `space_id` and `api_url`

The file watcher picks up the new space immediately and begins indexing.

## Testing

E2e tests are self-contained — each test creates its own SQLite database in a temp directory and starts the API in-process. **No running daemon is required.**

```bash
npm run typecheck -w packages/arkeon
npm test -w packages/arkeon             # unit tests
npm run test:e2e -w packages/arkeon     # e2e tests
```

For interactive verification against a running daemon (e.g. exercising the CLI end-to-end), use a named worktree instance per the pattern above.

## Notes

- State lives in `$ARKEON_WIKI_HOME` (default `~/.arkeon-wiki/`). Override with the env var or `--data-dir`.
- After schema changes, delete `~/.arkeon-wiki/<name>/data/arke.db` and restart — migrations are idempotent but a fresh database is the most reliable way to exercise the migration path from empty.
- The instance registry at `~/.arkeon-wiki/instances/` is updated on `up` / `down`. Stale entries from crashed processes are pruned by `arkeon-wiki status` and `arkeon-wiki ls`.
- Search uses ripgrep against each space's `watch_dir` — there's nothing to index ahead of time.
