---
name: local-dev
description: Start the local development environment (embedded Postgres + Meilisearch + API) and run e2e tests.
disable-model-invocation: true
argument-hint: [start|test|reset|stop|status]
allowed-tools: Bash(npm *, npx *, curl *, pkill *, sleep *, kill *, lsof *, ls *, cat *, mkdir *, rm *), Read, TaskOutput
---

# Local Development Environment

Manage the local dev stack via the `arkeon` CLI. Everything runs as a single Node process — embedded Postgres, spawned Meilisearch, and the API server — no Docker.

## Stack Management

### `start` (default)

Use `arkeon up` to start the stack as a background daemon:

```bash
npx tsx packages/arkeon/src/index.ts up
```

This:
- Starts embedded Postgres + Meilisearch + API server
- Registers the instance at `~/.arkeon-wiki/instances/<port>.json`
- Registers the "admin" profile in the instance actor registry
- Stores the admin key in the CLI credential store
- Polls `/health` until ready (up to 120s — first run downloads ~100MB Meilisearch binary)

For **named instances** (parallel stacks):
```bash
npx tsx packages/arkeon/src/index.ts up --name my-feature
```
Each named instance gets its own `ARKEON_WIKI_HOME` at `~/.arkeon-wiki/<name>/`, its own port, and its own data.

Check it's running:
```bash
npx tsx packages/arkeon/src/index.ts status
```

### `stop`

```bash
npx tsx packages/arkeon/src/index.ts down [name]
```

Gracefully drains the API, stops Meilisearch, stops Postgres. No orphan processes.

### `reset`

```bash
npx tsx packages/arkeon/src/index.ts reset --force
```
Wipes `~/.arkeon-wiki/data/` but preserves secrets and Meilisearch binary. Use `--hard` to wipe everything.

### `status`

```bash
npx tsx packages/arkeon/src/index.ts status
```
Shows: process state, health, seed state, LLM config, state directory, running instances, and repo binding info (if in an initialized repo).

## Worktree Isolation

**Each worktree MUST run its own named instance and only use its own CLI build.** The CLI and server are the same package — there's no version negotiation. Running worktree B's CLI against worktree A's server will break if the branches have schema or API differences.

```bash
WORKTREE_NAME=$(basename "$PWD")
npx tsx packages/arkeon/src/index.ts up --name "$WORKTREE_NAME"
```

This gives each worktree:
- Its own `ARKEON_WIKI_HOME` at `~/.arkeon-wiki/<name>/` (Postgres data, Meilisearch, secrets)
- Its own port (auto-selected, avoids collisions)
- Its own entry in `~/.arkeon-wiki/instances/` and its own actor registry
- Running its own branch's built code

Always run `arkeon init`, `arkeon auth`, and all other commands **from the same worktree** that started the instance. Don't cross worktree/instance boundaries.

Main tree (not a worktree) uses the default instance: `~/.arkeon-wiki/`, port 8000.

## Repo Binding and Auth

### Initialize a repo

After the stack is running, bind a repo to it:

```bash
cd /path/to/my-repo
npx tsx packages/arkeon/src/index.ts init my-project
```

This creates:
- An ingestor actor on the graph
- `.arkeon/state.json` with `api_url`, `space_id`, `current_actor`
- Actor key in `~/.config/arkeon-cli/credentials.json`
- Entry in the instance actor registry

### Auth profiles

All CLI commands auto-resolve identity from the repo's active profile. No `ARKE_API_KEY` needed.

```bash
# Show current identity
npx tsx packages/arkeon/src/index.ts auth status

# List profiles for this instance
npx tsx packages/arkeon/src/index.ts auth profiles

# Create a new actor profile
npx tsx packages/arkeon/src/index.ts auth add reviewer --kind agent

# Switch active profile
npx tsx packages/arkeon/src/index.ts auth use reviewer

# Remove a profile (--delete also deactivates the graph actor)
npx tsx packages/arkeon/src/index.ts auth remove reviewer
```

The resolution chain: `ARKE_API_KEY` env (override) -> repo `state.actors` (per-repo) -> instance actor registry (per-instance) -> global credential store.

## Testing

### `test`

1. Ensure the stack is running (`arkeon up` if not).
2. Get admin key from `~/.arkeon-wiki/secrets.json`.
3. Run e2e tests:
   ```bash
   ADMIN_KEY=$(cat ~/.arkeon-wiki/secrets.json | python3 -c "import sys,json; print(json.load(sys.stdin)['adminBootstrapKey'])")
   E2E_BASE_URL=http://localhost:8000 \
   ADMIN_BOOTSTRAP_KEY="$ADMIN_KEY" \
   npm run test:e2e -w packages/arkeon
   ```

For named instances, adjust the port and secrets path:
```bash
ADMIN_KEY=$(cat ~/.arkeon-wiki/<name>/secrets.json | python3 -c "import sys,json; print(json.load(sys.stdin)['adminBootstrapKey'])")
E2E_BASE_URL=http://localhost:<port> \
ADMIN_BOOTSTRAP_KEY="$ADMIN_KEY" \
npm run test:e2e -w packages/arkeon
```

## Notes

- First run downloads the Meilisearch binary (~100MB) into `~/.arkeon-wiki/bin/`. Cached after that.
- Secrets are generated on first run and stored in `$ARKEON_WIKI_HOME/secrets.json`. `reset` preserves them; `reset --hard` wipes them.
- After schema SQL changes, `reset` and restart — migrations are idempotent but a fresh cluster is the reliable way to exercise the full chain.
- The instance registry at `~/.arkeon-wiki/instances/` is cleaned up on `arkeon down`. Stale entries from crashed processes are pruned by `arkeon status`.
