# arkeon-wiki

Filesystem-first knowledge graph. You point it at directories, it watches for changes, indexes files into SQLite, and builds a relationship graph from markdown links between them.

**Repo**: `Arkeon-Technologies/arkeon-wiki` (branch: `main`)

## How it works

1. `arkeon-wiki up` — starts SQLite database + API server as a detached background daemon (survives the terminal closing)
2. `arkeon-wiki init` — registers the current directory as a space; the daemon starts watching it
3. You add/edit/delete files — the file watcher detects changes and syncs to SQLite automatically
4. Wiki files (`wiki/**/*.md`) use YAML frontmatter for structured metadata and standard markdown links for cross-references
5. Links between wiki files become relationship edges in SQLite

There are no manual sync commands. The filesystem is the source of truth.

`up` is the recommended entry point. Power users running under their own
process supervisor (pm2, launchd, systemd, docker) can use `start` for
foreground operation instead.

## Project structure

Two npm workspaces. Only one is published.

- `packages/arkeon/` — the main package, published as `arkeon-wiki` on npm. CLI binary, Hono API server, schema migrations, sync engine.
  - `src/index.ts` — CLI entry (commander)
  - `src/cli/commands/local/` — daemon lifecycle (up, down, start, stop, status, ls, logs)
  - `src/cli/commands/repo/` — directory-scoped commands (init, search)
  - `src/cli/lib/local-runtime.ts` — paths, pidfile, named-instance helpers
  - `src/cli/lib/instances.ts` — running-instance registry
  - `src/server/` — Hono API server, routes, sync engine, file watcher
  - `src/schema/` — SQLite migrations + runner
- `packages/explorer/` — browser SPA (Vite), not published. Currently needs updating for the new API.

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

- YAML between `---` fences. Parsed with js-yaml's `JSON_SCHEMA` so values map cleanly to JSON-compatible types (no Norway problem — `country: NO` stays the string `"NO"`). Properties are serialized to JSON text in SQLite.
- Supports nested mappings, sequences, multi-line strings (`|` literal, `>` folded), and `#` comments.
- **Quote numeric-looking strings** you want to keep as strings (e.g. `version: "1.10"` — unquoted `1.10` becomes the float `1.1`). The serializer is defensive on the way out — IDs and digit-only strings are auto-quoted on write — but on read, what you write is what you get.
- `id` is auto-generated on first sync if missing, written back to the file.
- `label` is required. Everything else is arbitrary.
- Standard markdown links (`[text](path.md)`) become relationship edges.

YAML is a superset of JSON, so wikis written with the old JSON-style frontmatter (`---\n{ ... }\n---`) still parse correctly. The first sync that writes back a generated `id` will rewrite the file in YAML form — heads-up if you have uncommitted changes to a wiki that was authored with JSON frontmatter.

## Ingestion

A single agent role — `ingestor` — turns sources into wikis. When a source file is added or updated, the ingestor reads it, looks for related wikis (existing ones via `list_wikis` / `search`, new ones it decides to create), and either edits the relevant wiki body in place (SEARCH/REPLACE) or writes a new wiki file. Provenance is captured as plain markdown links from the wiki body back to the source path — those become relationship edges in SQLite via the same link-resolution path that handles wiki↔wiki links.

The trigger is automatic. When the watcher sees a file event under the space's `watch_dir` that is **not** under `wiki/**` or `.arkeon/**`, it enqueues an ingestor run via `agent_queue` (a persistent FIFO). A per-space worker drains the queue, claims one item, calls `runAgent`, and either DELETEs the row on success or resets `started_at = NULL` and records `last_error` on failure. The `wiki/**` exclusion is hardcoded — it's the safety property that prevents the agent's own writes from re-firing the role infinitely. Operator-tunable include/exclude lands later.

The queue is crash-safe: `started_at + 5min` lease semantics mean a daemon that died mid-run leaves an orphan that gets reclaimed on the next startup. Combined with `agent_runs` idempotency (skipping replays of the same input hash), the worst case after a crash is "we re-run the role, the runtime sees we already finished it, no-op."

The pre-2026-04 `contributions[]` frontmatter inbox and matching SQLite table have been removed — the editor pattern they were designed for collapsed into a single ingest step. If you have wiki files left over with `contributions:` arrays in their frontmatter from older versions, they parse fine (just become unused properties); the wikis themselves are unaffected.

## Schema

Four tables in SQLite:

- `spaces` — registered directories (id, name, watch_dir)
- `entities` — wikis and source files (id, space_id, type, label, source_path, source_hash, properties JSON text)
- `relationships` — edges between entities (source_id, target_id, predicate, link_text, link_path)
- `agent_runs` — idempotency tracking for the agent runtime, keyed by `(role, idempotency_key)` with an `input_hash` so re-triggers on the same input skip cleanly.
- `agent_queue` — persistent FIFO of pending agent work. The watcher inserts on file events; the per-space worker claims, runs, and DELETEs on success. Lease pattern (`started_at + 5min`) makes it crash-safe.

No actors, no auth, no queues, no versioning. Schema in `src/schema/001-foundation.sql`.

## Key modules

- `src/server/lib/sync.ts` — `syncFile()`: the core primitive. Reads a file, parses frontmatter, upserts entity, resolves links to relationship edges.
- `src/server/lib/fs-watcher.ts` — watches registered directories, debounces changes, calls `syncFile()` / `removeByPath()`.
- `src/server/lib/frontmatter.ts` — parse/serialize YAML frontmatter.
- `src/server/lib/markdown-links.ts` — extract and resolve markdown links.
- `src/server/lib/search.ts` — ripgrep adapter: spawns `rg --json` per space, parses match events, joins paths back to entities, ranks by `match_count`.
- `src/server/lib/wiki-paths.ts` — pure helpers for routing labels to wiki file paths: `slugify`, `normalizeLabel`, `wikiPathFor(subject_type, label)`, `findFreePath`.
- `src/server/lib/file-edits.ts` — the universal mutation primitive. `applyEdit(space, edit)` is the chokepoint every agent and routing helper uses; runs `syncFile`/`removeByPath` after each change.
- `src/server/agents/` — the agent runtime: declarative `.arkeon/agents.yaml` config (Zod-validated), built-in `ingestor` role template, role-builder that merges YAML + builtins + env, tool registry (`read_file`, `list_wikis`, `search`, `edit_file`), the runAgent loop (Vercel AI SDK), and the per-space scheduler that drives auto-triggering. `edit_file` is the only mutation tool — three modes (CREATE, APPEND, REPLACE) dispatched on whether `search` is empty and whether the file exists. There's no overwrite path.
- `src/server/lib/agent-queue.ts` — pure SQL helpers around the `agent_queue` table (`enqueue`, `claimNext`, `complete`, `fail`, `reclaimOrphans`).
- `src/server/agents/path-filter.ts` — `shouldTrigger(path)` — the hardcoded `wiki/**` + `.arkeon/**` filter the scheduler consults before enqueueing. Single source of truth; when user-tunable include/exclude lands, this file is the place.

## API endpoints

- `POST /spaces` — register a directory
- `GET /spaces` — list spaces
- `GET /wikis?space_id=...&subject_type=...&status=...&label_contains=...&sort=...&include=...` — list wikis with frontmatter filters; `label_contains` is a case-insensitive substring match (so "Baker Street" finds "221B Baker Street"); `include=relationships` adds edges, `include=counts` attaches per-wiki incoming/outgoing link counts. The legacy `label_prefix` query is accepted as an alias and gets the same substring semantics.
- `GET /wikis/{id}?include=content` — wiki properties + relationships (and body if requested)
- `DELETE /wikis/{id}` — remove wiki from the index
- `GET /search?q=...&space_id=...&limit=...&snippets=...&regex=...` — keyword search via ripgrep against the watched directory; returns ranked entity hits with line snippets
- `GET /health` / `GET /ready`

No auth required. Content lives on disk — the API returns metadata and relationships only.

## Search

Keyword search is filesystem-first: there is no keyword index in SQLite. The
`/search` endpoint and `arkeon-wiki search` CLI spawn ripgrep (bundled via
`@vscode/ripgrep`, cross-platform) against each space's `watch_dir`, parse
`--json` output, and join the matched paths back to entities. Results are
ranked by `matched_lines` count.

Vector / semantic search is planned next (sqlite-vec + EmbeddingGemma-300M)
and will be fused with ripgrep results via reciprocal rank fusion.

## Commands

```bash
arkeon-wiki up                  # start as a detached background daemon
arkeon-wiki down                # stop the daemon (alias: stop)
arkeon-wiki status              # is it running?
arkeon-wiki ls                  # list all running instances
arkeon-wiki logs [-f]           # print/tail the daemon log
arkeon-wiki init                # register cwd as a space
arkeon-wiki search <query>      # keyword search (defaults to bound space)
arkeon-wiki start               # foreground (for use under pm2/launchd/etc.)
```

Run multiple instances side by side with `--name`:

```bash
arkeon-wiki up --name dev-a     # state at ~/.arkeon-wiki/dev-a/, port derived from name
arkeon-wiki up --name dev-b     # independent daemon, different port
arkeon-wiki ls
arkeon-wiki down --name dev-a
```

The port for a named instance is `8000 + sha256(name) mod 999 + 1`, so the
same name always picks the same port.

## Testing

```bash
npm run typecheck -w packages/arkeon    # type checking
npm test -w packages/arkeon             # unit tests (frontmatter, link parsing)
npm run test:e2e -w packages/arkeon     # e2e tests (spins up SQLite + API server)
```

E2e tests start a real stack in-process — no running instance needed.

## State

- `~/.arkeon-wiki/` — default instance home (SQLite database, pidfile, log)
- `~/.arkeon-wiki/<name>/` — named instance home (one per `--name`)
- `~/.arkeon-wiki/<home>/data/arke.db` — the SQLite database file
- `~/.arkeon-wiki/<home>/arkeon.pid` — pidfile for the daemon
- `~/.arkeon-wiki/<home>/arkeon.log` — daemon stdout/stderr (rotated by user, not by us)
- `~/.arkeon-wiki/instances/<name>.json` — registry of running instances (powers `ls`)
- `.arkeon/state.json` — per-directory space binding (space_id, api_url)

Override the state dir with `ARKEON_WIKI_HOME` env var or `--data-dir`.

## Schema migrations

Single file: `001-foundation.sql`. Must be idempotent (all `IF NOT EXISTS`). Runs on every startup.

## What's NOT here (yet)

- No vector search (sqlite-vec + EmbeddingGemma planned, hybrid RRF with ripgrep)
- No FTS5 / BM25 ranking (ripgrep gives substring matching only)
- No auth / API keys
- No explorer (needs updating for new API)

The old architecture with all of these features is preserved on the `archive/pre-fs-first` branch and in a local worktree at `../arkeon-wiki-archive/` for reference.
