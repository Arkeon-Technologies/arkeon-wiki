# Agents guide — arkeon-wiki

If you're an AI coding assistant operating in this repo or in a directory bound to a running arkeon-wiki daemon, this is your toolbox. For human-oriented docs see [README.md](./README.md); for full architectural context see [CLAUDE.md](./CLAUDE.md).

## What arkeon-wiki is

A filesystem-first knowledge graph. A user points the daemon at one or more directories ("spaces"). The daemon watches files, parses YAML frontmatter from `wiki/**/*.md` files, resolves markdown links between them, and indexes everything into a local SQLite database. The filesystem is the source of truth — SQLite is the index.

Three things live in SQLite: `spaces`, `entities` (one per file), and `relationships` (markdown links resolved to edges). No auth, no queues, no actors, no background workers. One process, one binary.

## CLI

Install: `npm install -g arkeon-wiki`. Then:

| Command | What it does |
|---|---|
| `arkeon-wiki up [--name <n>]` | Start the daemon as a detached background process. Survives terminal closing. |
| `arkeon-wiki down [--name <n>]` | Stop the daemon. Alias: `stop`. |
| `arkeon-wiki status` | Show daemon state, port, and bound space (if any). |
| `arkeon-wiki ls` | List every running named instance. |
| `arkeon-wiki logs [-f]` | Print or tail the daemon log. |
| `arkeon-wiki init` | Register the current directory as a space. Daemon starts watching it. |
| `arkeon-wiki search <query> [--all] [--space <id>] [--limit N] [--snippets N] [--regex]` | Keyword search via ripgrep. Defaults to the bound space. |
| `arkeon-wiki start` | Foreground mode for use under pm2/launchd/systemd/docker. |

`--name <n>` runs a parallel instance with its own state dir at `~/.arkeon-wiki/<n>/` and a deterministic port (`8000 + sha256(name) mod 999 + 1`). Default instance lives at `~/.arkeon-wiki/`, port 8000.

## API

Default base URL: `http://localhost:8000`. No auth. JSON in, JSON out. All non-2xx responses follow the [error contract](./docs/dev/ERROR_CONTRACT.md).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/spaces` | Register a directory. Body: `{ name, watch_dir }`. |
| `GET` | `/spaces` | List spaces with entity counts. |
| `GET` | `/spaces/:id` | Get a single space. |
| `GET` | `/entities?space_id=&type=&subject_type=&status=&label_contains=&inbound_min=&inbound_max=&outbound_min=&outbound_max=&has_unresolved_outbound=&updated_since=&edited_by_role=&sort=&limit=&offset=&include=` | List entities — wikis (`type=wiki`), source files (`type=file`), and `[[wikilink]]`-derived stubs (`type=stub`). `type` is a comma-list; omit to include all. `has_unresolved_outbound=true` finds entities pointing at stubs (open threads). `include=counts` attaches `counts.inbound`/`counts.outbound`; `include=relationships` adds the edges. `sort` is `updated_at` \| `label` \| `inbound` \| `outbound`. |
| `GET` | `/entities/:id?include=content` | Properties + incoming/outgoing relationships for any entity (wiki/file/stub). `include=content` reads the file body from disk. |
| `GET` | `/entities/:id/history?since=&role=&limit=&offset=` | Audit log of edits to this entity (newest first). |
| `DELETE` | `/entities/:id` | Remove an entity from the index (cascades to relationships and chunks). |
| `GET` | `/search?q=&space_id=&limit=&snippets=&regex=` | Ripgrep-backed keyword search. Returns ranked entity hits with line snippets. |
| `GET` | `/health` | Liveness. Always `200` if the process is up. |
| `GET` | `/ready` | Readiness. `200` if SQLite responds; `503` otherwise. |

Full reference with response shapes and examples: [docs/user/API.md](./docs/user/API.md).

## Wiki file format

```markdown
---
id: 01JSG...
label: Claude Shannon
subject_type: person
birth_year: 1916
fields:
  - mathematics
  - information theory
---

Claude Shannon was the father of information theory.

He worked at [Bell Labs](../organization/bell-labs.md).
```

YAML frontmatter between `---` fences. Only `label` is required. `id` is auto-generated and written back on first sync. Markdown links resolve into relationship edges. Files outside `wiki/` are still indexed but treated as plain "file" entities without frontmatter.

Quote numeric-looking strings (`version: "1.10"`) — unquoted `1.10` becomes the float `1.1`.

## How to query the graph from an AI session

In a directory bound to a running daemon (i.e. `arkeon-wiki init` has been run there), the `.arkeon/state.json` file contains `space_id` and `api_url`. Use those to scope your queries:

```bash
# Find wikis that mention "shannon"
curl "$(jq -r .api_url .arkeon/state.json)/search?q=shannon&space_id=$(jq -r .space_id .arkeon/state.json)"

# Pull the full content of a specific wiki
curl "$(jq -r .api_url .arkeon/state.json)/entities/<id>?include=content"

# Walk relationships
curl "$(jq -r .api_url .arkeon/state.json)/entities/<id>" | jq '.relationships'
```

If the daemon isn't running, start it with `arkeon-wiki up` — it survives the terminal closing.

## Constraints to be aware of

- **No auth.** Anyone who can reach the port can read and delete entities. Designed for `localhost`. Don't expose the API publicly without putting a reverse proxy in front of it.
- **Filesystem is truth.** Don't `INSERT` into SQLite directly — your changes will be overwritten the next time the watcher reconciles. Edit the underlying markdown files and let the watcher catch up.
- **Keyword-only search.** Search is ripgrep against the filesystem. No vector / semantic search in this build.
- **One package, one process.** The CLI and server are the same binary. Don't run worktree A's CLI against worktree B's daemon — use `--name` to keep instances separate.

## Pointers for working on the codebase itself

- `packages/arkeon/src/server/lib/sync.ts` — the core primitive: parse a file, upsert an entity, resolve links to edges.
- `packages/arkeon/src/server/lib/fs-watcher.ts` — watches directories, debounces, calls `syncFile()`.
- `packages/arkeon/src/server/lib/search.ts` — ripgrep adapter and result ranking.
- `packages/arkeon/src/schema/001-foundation.sql` — the entire schema.
- E2e tests at `packages/arkeon/test/e2e/` are self-contained (each spins up a fresh SQLite DB in a temp directory). No running daemon required.

## Skills shipped with this repo

For Claude Code users, `.claude/skills/` contains:

- `local-dev` — daemon lifecycle and worktree isolation.
- `fix-issue` — full PR workflow: claim issue, create worktree, implement, test, open PR.
- `merge-pr` — review and merge an open PR.
- `review-docs` — generic doc review checklist.

These are for humans/agents working *on* arkeon-wiki, not for users *of* it.
