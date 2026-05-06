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
- `short_description` (optional, single-line) is recognized by the chunker and embedded into the per-wiki "card" chunk for semantic search.
- Standard markdown links (`[text](path.md)`) become relationship edges.

YAML is a superset of JSON, so wikis written with the old JSON-style frontmatter (`---\n{ ... }\n---`) still parse correctly. The first sync that writes back a generated `id` will rewrite the file in YAML form — heads-up if you have uncommitted changes to a wiki that was authored with JSON frontmatter.

## Ingestion

A single agent role — `ingestor` — turns sources into wikis. When a source file is added or updated, the ingestor reads it, looks for related wikis (existing ones via `list_wikis` / `search`, new ones it decides to create), and either edits the relevant wiki body in place (SEARCH/REPLACE) or writes a new wiki file. Provenance is captured as plain markdown links from the wiki body back to the source path — those become relationship edges in SQLite via the same link-resolution path that handles wiki↔wiki links.

The trigger is automatic. When the watcher sees a file event under the space's `watch_dir` that is **not** under `wiki/**` or `.arkeon/**`, it enqueues an ingestor run via `agent_queue` (a persistent FIFO). A per-space worker drains the queue, claims one item, calls `runAgent`, and either DELETEs the row on success or resets `started_at = NULL` and records `last_error` on failure. The `wiki/**` exclusion is hardcoded — it's the safety property that prevents the agent's own writes from re-firing the role infinitely. Operator-tunable include/exclude lands later.

The queue is crash-safe: `started_at + 5min` lease semantics mean a daemon that died mid-run leaves an orphan that gets reclaimed on the next startup. Combined with `agent_runs` idempotency (skipping replays of the same input hash), the worst case after a crash is "we re-run the role, the runtime sees we already finished it, no-op."

The pre-2026-04 `contributions[]` frontmatter inbox and matching SQLite table have been removed — the editor pattern they were designed for collapsed into a single ingest step. If you have wiki files left over with `contributions:` arrays in their frontmatter from older versions, they parse fine (just become unused properties); the wikis themselves are unaffected.

## Schema

Tables in SQLite:

- `spaces` — registered directories (id, name, watch_dir)
- `entities` — wikis and source files (id, space_id, type, label, source_path, source_hash, properties JSON text)
- `relationships` — edges between entities (source_id, target_id, predicate, link_text, link_path)
- `agent_runs` — idempotency tracking for the agent runtime, keyed by `(role, idempotency_key)` with an `input_hash` so re-triggers on the same input skip cleanly.
- `agent_queue` — persistent FIFO of pending agent work. The watcher inserts on file events; the per-space worker claims, runs, and DELETEs on success. Lease pattern (`started_at + 5min`) makes it crash-safe.
- `entity_chunks` — per-wiki chunks for embedding-based search (issue #47). Populated on every wiki sync; opt out with `ARKEON_WIKI_CHUNKING=0`. Cascades on entity delete.
- `entity_embeddings` — pivot tracking which model + chunk content_hash produced each embedding. Cascades from `entity_chunks`.
- `chunk_vectors` — `vec0` virtual table holding the actual float[256] vectors (sqlite-vec). Joined to chunks via `chunk_id`.
- `embedding_queue` — per-entity work queue drained by the in-process embedding worker. Same lease pattern as `agent_queue`.

No actors, no auth, no versioning. Schema across `src/schema/001-foundation.sql`, `002-chunks.sql`, and `003-embeddings.sql`.

## Key modules

- `src/server/lib/sync.ts` — `syncFile()`: the core primitive. Reads a file, parses frontmatter, upserts entity, resolves links to relationship edges. For wiki files, also runs the chunker and reconciles `entity_chunks` via a content_hash-keyed diff (UPDATE in place for unchanged chunks, INSERT for new, DELETE for removed) so embeddings survive across edits.
- `src/server/lib/fs-watcher.ts` — watches registered directories, debounces changes, calls `syncFile()` / `removeByPath()`.
- `src/server/lib/frontmatter.ts` — parse/serialize YAML frontmatter.
- `src/server/lib/markdown-links.ts` — extract and resolve markdown links.
- `src/server/lib/search.ts` — ripgrep adapter: spawns `rg --json` per space, parses match events, joins paths back to entities, ranks by `match_count`.
- `src/server/lib/wiki-paths.ts` — pure helpers for routing labels to wiki file paths: `slugify`, `normalizeLabel`, `wikiPathFor(subject_type, label)`, `findFreePath`.
- `src/server/lib/file-edits.ts` — the universal mutation primitive. `applyEdit(space, edit)` is the chokepoint every agent and routing helper uses; runs `syncFile`/`removeByPath` after each change.
- `src/server/agents/` — the agent runtime: declarative `.arkeon/agents.yaml` config (Zod-validated), built-in `ingestor` role template, role-builder that merges YAML + builtins + env, tool registry (`read_file`, `list_wikis`, `search`, `edit_file`), the runAgent loop (Vercel AI SDK), and the per-space scheduler that drives auto-triggering. `edit_file` is the only mutation tool — three modes (CREATE, APPEND, REPLACE) dispatched on whether `search` is empty and whether the file exists. There's no overwrite path.
- `src/server/lib/agent-queue.ts` — pure SQL helpers around the `agent_queue` table (`enqueue`, `claimNext`, `complete`, `fail`, `reclaimOrphans`).
- `src/server/agents/path-filter.ts` — `shouldTrigger(path)` — the hardcoded `wiki/**` + `.arkeon/**` filter the scheduler consults before enqueueing. Single source of truth; when user-tunable include/exclude lands, this file is the place.
- `src/server/lib/chunker.ts` — `chunkWiki(parsed, label)`: pure function that turns a wiki into the chunks the embedder will see. Issue #47. Card chunk (label + subject_type + aliases + short_description + lead paragraph) plus one chunk per non-empty H2 with the heading path prepended. Oversized sections fall back to H3-then-paragraph splits with ~80-token overlap. Runs on every wiki sync (`syncWikiFile()`); set `ARKEON_WIKI_CHUNKING=0` to disable.
- `src/server/lib/embedding-queue.ts` — pure SQL helpers around `embedding_queue` (enqueue, claimNext, complete, fail, reclaimOrphans, queueStats, waitForDrain). Same lease pattern as `agent-queue.ts`.
- `src/server/lib/embedder/` — the embedder runtime. `index.ts` resolves a singleton via `getEmbedder()` (default: ONNX; `ARKEON_WIKI_EMBEDDER=mock|onnx` overrides). `onnx.ts` is the bundled production backend: `@huggingface/transformers` + `embeddinggemma-300m-ONNX` (q8 quantised, ~309 MB), weights download on first daemon start to `~/.arkeon-wiki/models/` (override with `ARKEON_WIKI_MODELS_DIR`). The model emits 768-d, we slice to the leading 256 + L2-renormalise (Matryoshka). EmbeddingGemma requires distinct prefixes for queries and documents — the embedder applies them based on `kind`. `mock.ts` is a deterministic SHA-derived embedder used in tests; in production it's only reached if ONNX construction throws synchronously. `worker.ts` claims entities off `embedding_queue`, embeds their chunks (`kind="document"`), and writes to `chunk_vectors` + `entity_embeddings`. While the model is downloading or loading, `searchVector()` returns `{model: "warming", hits: []}` so user queries don't block on a 309 MB download.
- `src/server/lib/search.ts` — both search strategies. `searchKeyword()` is the ripgrep-backed entity-level keyword search; `searchVector()` embeds the query and runs KNN over `chunk_vectors`, joining back for entity metadata and chunk text. Pure functions; the route layer composes them.

## API endpoints

- `POST /spaces` — register a directory
- `GET /spaces` — list spaces
- `GET /wikis?space_id=...&subject_type=...&status=...&label_contains=...&sort=...&include=...` — list wikis with frontmatter filters; `label_contains` is a case-insensitive substring match (so "Baker Street" finds "221B Baker Street"); `include=relationships` adds edges, `include=counts` attaches per-wiki incoming/outgoing link counts.
- `GET /wikis/{id}?include=content` — wiki properties + relationships (and body if requested)
- `DELETE /wikis/{id}` — remove wiki from the index
- `GET /search?q=...&mode=keyword|vector|both&space_id=...&limit=...&snippets=...&regex=...` — search across registered spaces. Default `mode=both` runs keyword (ripgrep) and vector (sqlite-vec KNN) in parallel and returns each result set in its own namespace (`response.keyword`, `response.vector`). No fusion. Keyword hits are entity-level with line snippets ranked by match count; vector hits are chunk-level sorted by similarity (1 − cosine_distance) with `chunk_id`, `heading_path`, and the chunk text.
- `GET /health` / `GET /ready`

No auth required. Content lives on disk — the API returns metadata and relationships only.

## Search

Two strategies, no fusion. The `/search` endpoint and `arkeon-wiki search` CLI run whichever the caller asks for and dump the results in a namespaced response — `{keyword: ..., vector: ...}`. Caller (UI, LLM, scripted client) decides what to do with both.

**Keyword** (`mode=keyword`) is filesystem-first: ripgrep (bundled via `@vscode/ripgrep`, cross-platform) spawns against each space's `watch_dir`, parses `--json` output, joins matched paths back to entities, and ranks by `matched_lines` count. There is no keyword index in SQLite — the filesystem is the index.

**Vector** (`mode=vector`) embeds the query via the bundled ONNX embedder (`embeddinggemma-300m`, q8, 256 d after Matryoshka truncation), runs KNN against the `chunk_vectors` (sqlite-vec) virtual table, joins back to `entity_chunks` and `entities`, and returns chunk-level hits sorted by similarity (1 − cosine_distance, higher is better). No threshold; top-K with caller-side filtering. The vector response includes the embedder's `model` identifier — `onnx:embeddinggemma-300m@256` when ready, `warming` while the first-run download is in flight, `unavailable` if the model failed to load — so clients can act on retrieval state without parsing logs.

**Both** (`mode=both`, default) runs the two in parallel with `Promise.allSettled` and populates both namespaces. If one strategy fails or is still warming, the other still returns and the failed/warming one is reported as empty hits — better UX than 5xx'ing a search query because half the pipeline isn't ready.

Real semantic embeddings ship in the box. On first `arkeon-wiki up`, the daemon eagerly kicks off the model download (~309 MB) in the background; vector queries during that window return the `warming` status so the user's UI never hangs on a download. Subsequent runs hit the local cache and the model is ready in seconds.

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

## Debugging agent runs

Agents emit verbose, human-readable logs to the daemon log unconditionally (`[agent/<role>/<level>] ...`). For *structured* per-event traces — every tool call, every edit, every phase boundary, with timing and token usage — set `ARKEON_WIKI_AGENT_TRACE=1`. Off by default (production).

When enabled, one JSON object per line is appended to `<arkeonHome>/agent-trace.jsonl` (override path with `ARKEON_WIKI_AGENT_TRACE_FILE`). Each event carries `ts`, `run_id`, `role`, `space_id`, `phase`, plus event-specific fields:

- `run.start` — phases planned, idempotency key, trigger path
- `run.skipped` — when alreadyProcessed short-circuits
- `phase.start` / `phase.end` — model, tool whitelist, step count, token usage, duration
- `tool.call` / `tool.result` — args (truncated to 500 chars), per-tool `summary` (e.g. `search` reports `keyword_hits`, `vector_hits`, `vector_model`; `list_wikis` reports `total`/`returned`), `duration_ms`, `ok`
- `edit` — path, edit_kind (create|append|replace), char counts (no body content)
- `run.end` / `run.error` — total steps, edits, usage, duration

Tail with `tail -f <path> | jq` or query with `jq -c 'select(.event=="tool.call" and .tool=="search")'`. The schema is unversioned debug-time output; consumers (jq queries, test harnesses) update with the producer.

## Schema migrations

`src/schema/*.sql`, applied in alphabetical order. Currently `001-foundation.sql` (entities, spaces, relationships, agent runtime), `002-chunks.sql` (`entity_chunks`), and `003-embeddings.sql` (`chunk_vectors` vec0 table, `entity_embeddings` pivot, `embedding_queue`). Must be idempotent (all `IF NOT EXISTS`). Runs on every startup. Note: `003-embeddings.sql` requires the sqlite-vec extension to be loaded; `initDb()` does this automatically before migrations run.

## What's NOT here (yet)

- No server-side fusion of keyword + vector results (RRF). `mode=both` returns parallel arrays; if a UI needs a single ranked list it does the merge client-side. The unfused-parallel shape is a deliberate choice for our LLM-downstream use case; if a fused mode turns out to be needed later we can add `mode=hybrid` as a fourth option without breaking existing callers.
- No FTS5 / BM25 ranking (ripgrep gives substring matching only)
- No auth / API keys
- No explorer (needs updating for new API)

The old architecture with all of these features is preserved on the `archive/pre-fs-first` branch and in a local worktree at `../arkeon-wiki-archive/` for reference.
