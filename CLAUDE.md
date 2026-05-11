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
- `short_description` (optional, single-line) is a convention for a one-sentence summary of the wiki's subject.
- Standard markdown links (`[text](path.md)`) must resolve to an existing entity. Unresolved standard links log a warning and are dropped (treated as typos). Use `[[wikilink]]` syntax for explicit "should-exist" intent — see below.
- `[[Label]]` and `[[Label|subject_type]]` — Obsidian/Roam-style wiki-links. The runtime computes the canonical path via `wikiPathFor(subject_type ?? 'concept', label)` (e.g. `[[Bell Labs|organization]]` → `wiki/organization/bell-labs.md`) and, if nothing's there yet, inserts a **placeholder wiki** at that path: `type='wiki'` with `source_hash IS NULL` (no file on disk). The placeholder holds the slot until a real wiki is written there, at which point the row is upgraded in place — its `id` is preserved so every inbound relationship survives. Placeholders are GC'd at the end of every sync once nothing points at them anymore. They're surfaced via the derived `unresolved` field on `/entities` listings (`?unresolved=true` to filter), not via a distinct `type`. The wiki-link form is the right choice when an agent wants to flag "this should exist" without inventing a path; standard markdown links remain for verified cross-references.
- **Cross-space wikilinks** (issue #101) — append a `space:NAME` segment to point at a wiki in a sibling space: `[[Bell Labs|organization|space:research-notes]]`. The two-segment shorthand `[[Bell Labs|space:research-notes]]` is also accepted (default `subject_type='concept'`). The `space:` marker is sniffed by prefix, so order doesn't matter — `[[X|t|space:Y]]` and `[[X|space:Y|t]]` parse the same. Cross-space wikilinks **must resolve to an existing wiki**; they never create a placeholder in the peer space. Unknown space, ambiguous space, or missing target = warn-and-drop. This is the read-only-across-spaces rule from #99 made concrete: writes (including placeholder allocation) stay scoped to the source's own space. The literal `[[…|space:…]]` form is preserved in `relationships.link_path`, so consumers can detect cross-space edges by substring without re-parsing.
- **The slug is whitespace-sensitive.** `slugify()` lowercases, drops punctuation, and replaces runs of whitespace with `-`. `[[Quantum Computing]]` becomes `wiki/concept/quantum-computing.md`; `[[QuantumComputing]]` (no space) becomes `wiki/concept/quantumcomputing.md` — a different path, a different placeholder. If two agents disagree on capitalization or word boundaries you can end up with two entities for the same subject. For now, normalize on the writing side; a fuzzy-match in `wikiPathFor` is a future-issue option if this becomes a real problem.

YAML is a superset of JSON, so wikis written with the old JSON-style frontmatter (`---\n{ ... }\n---`) still parse correctly. The first sync that writes back a generated `id` will rewrite the file in YAML form — heads-up if you have uncommitted changes to a wiki that was authored with JSON frontmatter.

## Writing (the `writer` role)

A single agent role — `writer` — turns recent sources into articles on a recurring cron schedule. Every tick, the writer queries `list_entities?type=file&inbound_max=0&sort=updated_at` to find recent unprocessed sources, reads the most interesting one or two, articulates a driving question, vector-searches articles for an existing answer, then either extends an existing article (`edit_file` annotate/replace/append) or writes a new one (`edit_file` create) at `wiki/article/<slug>.md`. Provenance is captured as plain markdown links from the article body back to the source path — those become relationship edges in SQLite via the same link-resolution path that handles wiki↔wiki links.

Articles are **horizontal**: one article spans many sources, growing as the corpus grows. The default body convention is four sections — `## Question` / `## Current answer` / `## Evidence` / `## Open threads` — but it's a soft convention, not enforced in code. Operators reshape it via `instructions:` in their `agents.yaml`.

The trigger is **purely cron-driven**. There is no event queue: the watcher's job ends at the SQLite mirror (`syncFile` on changes, `removeByPath` on deletes), and agents pick up new sources at their next scheduled tick by querying entities directly. Per-space serialization is enforced by an in-process mutex — at most one role can run in a given space at any time. If a role's tick fires while another role's run is in flight in the same space, the tick is skipped (skip-if-busy) and the next firing is computed from "now."

The bundled writer template ships `cron: "*/15 * * * *"` (every 15 minutes). **First-run cost note**: this means a fresh `arkeon-wiki up` against a corpus with `OPENAI_API_KEY` set will start spending API credit within 15 minutes of bootstrap — a few cents per tick on `gpt-5-mini`, more on stronger models. Operators who want to inspect the writer's behavior before letting it run should override the cadence in `.arkeon/agents.yaml` (`cron: "0 0 31 2 *"` is the canonical "never fire" idiom — Feb 31 doesn't exist), then bump it back when ready. A role with no resolvable `cron:` simply doesn't auto-run.

**Downtime → missed ticks are dropped.** No persistence of last-fire times. A daemon down across N firings of `*/15 * * * *` doesn't fire those N ticks; it picks up at the next instant after restart. This is fine for the writer (each tick observes current state and picks unprocessed sources from scratch), but a future non-idempotent role would need a different mechanism.

Why no event queue? The cron model lets the role decide its own work from current state, which means new behaviors (reflector picking articles with open threads, bridger rotating across spaces) need only a different prompt + cron — no scheduler changes. Each cron tick is a fresh "look at state and decide" — no idempotency layer, no replay protection. The role's prompt is responsible for picking work that hasn't been processed yet (e.g. the writer queries `list_entities?type=file&inbound_max=0` to find unprocessed sources).

## Schema

Tables in SQLite:

- `spaces` — registered directories (id, name, watch_dir)
- `entities` — wikis (`type='wiki'`) and source files (`type='file'`). Columns: id, space_id, type, label, source_path, source_hash, properties JSON text. A wiki with `source_hash IS NULL` is a **placeholder** — left by a `[[wikilink]]` whose target hasn't been authored yet. Placeholders are upgraded in place when a real file is written at their path; the entity id is preserved so inbound relationships survive.
- `relationships` — edges between entities (source_id, target_id, predicate, link_text, link_path)

No actors, no auth, no versioning. Schema in `src/schema/*.sql`. Phase 0 dropped the chunker/embedder pipeline (`entity_chunks`, `chunk_vectors`, `entity_embeddings`, `embedding_queue`) and the `agent_runs` idempotency table; `007-drop-deprecated.sql` cleans them up on existing dev DBs.

## Key modules

- `src/server/lib/sync.ts` — `syncFile()`: the core primitive. Reads a file, parses frontmatter, upserts entity, resolves links to relationship edges.
- `src/server/lib/fs-watcher.ts` — watches registered directories, debounces changes, calls `syncFile()` / `removeByPath()`.
- `src/server/lib/frontmatter.ts` — parse/serialize YAML frontmatter.
- `src/server/lib/markdown-links.ts` — extract and resolve markdown links.
- `src/server/lib/search.ts` — ripgrep adapter: spawns `rg --json` per space, parses match events, joins paths back to entities, ranks by `matched_lines` count. Pure functions; the route layer composes them.
- `src/server/lib/wiki-paths.ts` — pure helpers for routing labels to wiki file paths: `slugify`, `normalizeLabel`, `wikiPathFor(subject_type, label)`, `findFreePath`.
- `src/server/lib/file-edits.ts` — the universal mutation primitive. `applyEdit(space, edit)` is the chokepoint every agent and routing helper uses; runs `syncFile`/`removeByPath` after each change.
- `src/server/agents/` — the agent runtime: declarative `.arkeon/agents.yaml` config (Zod-validated), bundled role templates (`templates/*.yaml` — currently just `writer`, loaded fresh from disk on every `buildAgentRole` / `loadBundledTemplates` call), role-builder that merges YAML + templates + env, tool registry (`read_file`, `list_entities`, `search`, `edit_file`), the runAgent loop (Vercel AI SDK), and the per-space cron scheduler that drives auto-triggering. Templates ship as YAML, not code — drop a new `templates/<name>.yaml` to add a role; no registration needed. `edit_file` is the only mutation tool — five modes (`create`, `append`, `replace`, `annotate`, `delete_section`) on an explicit `mode` discriminator. `replace` is Aider-style SEARCH/REPLACE; `annotate` splices `insert_text` after a unique anchor phrase without touching surrounding bytes (the load-bearing primitive for additive edits — the schema makes prose drift impossible); `delete_section` removes an ATX heading and its body up to the next same-or-higher heading. Whole-file deletion lives in `delete_wiki` (different tool, guarded `wiki/` prefix, required `reason`); not bundled with the writer. Roles may opt into cross-space reads via `spaces: [self, "other-space"]` (or `["*"]` for global) in agents.yaml; `runAgent` resolves the list against the live `spaces` table and stashes it on `ctx.allowedSpaces`, after which `read_file`/`search`/`list_entities` accept an optional `space` arg (name or id) — multi-space roles fan out across the whole allowed set when omitted, with each result row tagged `space_id` + `space`. `read_file` requires `space` on a multi-space role since a path-only call would be ambiguous. Writes (`edit_file`, `delete_wiki`) stay scoped to `ctx.space`.
- `src/server/agents/cron.ts` — thin wrapper around `cron-parser`. `nextTick(expr, from)` returns the next firing `Date`; `validateCronExpression(expr)` returns null on valid, error message on invalid. Used by the config layer for load-time validation and by the scheduler to drive its setTimeout chain.
- `src/server/agents/scheduler.ts` — per-space cron scheduler. Reads the merged config, builds every role with a resolvable `cron:` field, and schedules a `setTimeout` chain per role driven by the cron's next firing time. Per-space mutex enforces serialization (skip-if-busy on contention). `stop()` clears pending timers and waits for any in-flight run with a bounded `gracePeriodMs` (default 5s). No event queue, no orphan reclaim — single-daemon model.
- `src/server/agents/space-scope.ts` — issue #99. `resolveAllowedSpaces(scope, ownSpace)` turns a role's `spaces:` config (names / ids / `self` / `*`) into the concrete `Space[]` `runAgent` stashes on `ctx.allowedSpaces`; `resolveSpaceArg(arg, allowed)` validates a per-call `space` argument against that set. Read-only across spaces — `edit_file` and `delete_wiki` always target `ctx.space`. Ambiguous names error with the candidate ids so the operator (and the LLM) can disambiguate.

## API endpoints

- `POST /spaces` — register a directory
- `GET /spaces` — list spaces
- `GET /entities?space_id=...&type=...&subject_type=...&status=...&label_contains=...&inbound_min=...&inbound_max=...&outbound_min=...&outbound_max=...&unresolved=...&has_unresolved_outbound=...&updated_since=...&edited_by_role=...&sort=...&include=...` — generic entity listing across wikis (`type=wiki`) and source files (`type=file`). `type` is a comma list; omitting it returns both. Each row carries `unresolved: boolean` — true for placeholder wikis (no file on disk yet). `?unresolved=true|false` filters on it. Counts (`include=counts`) attach `counts.inbound`/`counts.outbound` per row. `has_unresolved_outbound=true` filters to entities pointing at placeholders (i.e. wikis with open threads). `edited_by_role` filters on the most-recent-edit's `by_role` (via the `entity_latest_edit` view). `sort` is `updated_at` | `label` | `inbound` | `outbound`. **Note:** `?type=stub` was removed in 006-collapse-stubs — use `?unresolved=true` instead.
- `GET /entities/{id}?include=content` — properties + relationships for any entity (wiki or file); `include=content` reads the file body from disk (skipped for placeholder wikis with no file yet).
- `GET /entities/{id}/history?limit=&offset=&since=&role=` — chronological audit log of edits to this entity from `entity_edits`.
- `DELETE /entities/{id}` — remove an entity from the index (cascades through relationships).
- `GET /search?q=...&space_id=...&type=...&limit=...&snippets=...&regex=...` — keyword search via ripgrep. Returns `{query, keyword: {hits, total, unmatched_files}}`. Entity-level hits ranked by match count, with line snippets. `q` may be repeated up to 10 times to OR multiple patterns in one ripgrep pass; match counts aggregate so multi-pattern hits naturally rank higher. `type` is a comma list (`wiki`, `file`).
- `GET /health` / `GET /ready`

No auth required. Content lives on disk — the API returns metadata and relationships only.

## Search

Filesystem-first keyword search via ripgrep (bundled via `@vscode/ripgrep`, cross-platform). For each registered space, spawns ripgrep against the space's `watch_dir` with `--json`, parses match events into per-file results, and joins back to entities by `source_path`. Ranked by `matched_lines` count. There is no keyword index in SQLite — the filesystem is the index.

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
- `phase.start` / `phase.end` — model, tool whitelist, step count, token usage, duration
- `tool.call` / `tool.result` — args (truncated to 500 chars), per-tool `summary` (e.g. `search` reports `keyword_hits`, `vector_hits`, `vector_model`; `list_entities` reports `total`/`returned`), `duration_ms`, `ok`
- `edit` — path, edit_kind (create|append|replace), char counts (no body content)
- `run.end` / `run.error` — total steps, edits, usage, duration

Tail with `tail -f <path> | jq` or query with `jq -c 'select(.event=="tool.call" and .tool=="search")'`. The schema is unversioned debug-time output; consumers (jq queries, test harnesses) update with the producer.

The writer is append-only — there is no built-in rotation, so the file grows as long as tracing stays on. That's fine for the intended use (turn it on for an investigation, off afterwards). Reset between investigations with `truncate -s 0 <path>` or `rm <path>` (the writer recreates it on next emit).

## Schema migrations

`src/schema/*.sql`, applied in alphabetical order. Currently `001-foundation.sql` (spaces, entities — runtime types are `'wiki' | 'file'`; the table's CHECK is permissive of the legacy `'stub'` value but no rows of that shape are created post-006 — relationships), `004-edits-and-triggers.sql` (`entity_edits` audit log, `entity_latest_edit` view), `005-edit-kinds.sql` (drops the `edit_kind` CHECK constraint so the runtime `EditKind` type is the authoritative enum), `006-collapse-stubs.sql` (migrates the legacy `type='stub'` rows into placeholder wikis — `type='wiki'` with `source_hash IS NULL` — and swaps the GC's partial index), and `007-drop-deprecated.sql` (Phase 0 cleanup: drops the legacy `entity_chunks`, `entity_embeddings`, `embedding_queue`, and `agent_runs` tables — no-op on fresh installs). The runner tracks applied files in `schema_migrations` so non-idempotent migrations (e.g. table-recreate dances, data migrations) only run once. Runs on every startup.

## What's NOT here (yet)

- No semantic / vector search — Phase 0 removed the chunker/embedder pipeline. Keyword (ripgrep) only.
- No FTS5 / BM25 ranking (ripgrep gives substring matching only)
- No auth / API keys
- No explorer (needs updating for new API)

The old architecture with all of these features is preserved on the `archive/pre-fs-first` branch and in a local worktree at `../arkeon-wiki-archive/` for reference.
