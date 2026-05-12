# arkeon-wiki

Filesystem-first knowledge graph. You point it at directories, it watches for changes, indexes files into SQLite, and builds a relationship graph from `<a href>` links between HTML wikis.

**Repo**: `Arkeon-Technologies/arkeon-wiki` (branch: `main`)

## How it works

1. `arkeon-wiki up` — starts SQLite + API server as a detached background daemon.
2. `arkeon-wiki init` — registers the current directory as a space; the daemon starts watching it.
3. You add/edit/delete files — the file watcher syncs to SQLite automatically.
4. Wiki articles (`wiki/**/*.html`) use `<title>` + `<meta>` tags for metadata and `<a href>` for cross-references.
5. Links between articles become relationship edges in SQLite.

The filesystem is the source of truth. SQLite is the index. There are no manual sync commands.

`up` is the recommended entry point. Power users running under their own process supervisor (pm2, launchd, systemd, docker) can use `start` for foreground operation.

## Project structure

One npm workspace, published as `arkeon-wiki` on npm.

- `packages/arkeon/` — the main package.
  - `src/index.ts` — CLI entry (commander)
  - `src/cli/commands/local/` — daemon lifecycle (up, down, start, stop, status, ls, logs)
  - `src/cli/commands/repo/` — directory-scoped commands (init, search)
  - `src/cli/lib/local-runtime.ts` — paths, pidfile, named-instance helpers
  - `src/cli/lib/instances.ts` — running-instance registry
  - `src/server/` — Hono API server, routes, sync engine, file watcher
  - `src/schema/` — SQLite migrations + runner

## Wiki file format

HTML article under `wiki/`. Subfolders allowed for organization (no `subject_type` namespacing):

```html
<!DOCTYPE html>
<html>
<head>
  <title>Photosynthesis</title>
  <meta name="label" content="Photosynthesis">
  <meta name="short_description" content="How plants convert light to chemical energy.">
</head>
<body>
  <h1>Photosynthesis</h1>
  <p>Occurs inside <a href="../wiki/chloroplast.html">chloroplasts</a>.</p>
</body>
</html>
```

Sync rules:
- `<title>` → `entities.label`
- Every `<meta name="X" content="Y">` → `properties[X] = Y` (stored as JSON text)
- Every `<a href="...">` → a row in `relationships` with `target_path` resolved relative to the article's directory
- External URLs (anything with a scheme: `https://`, `mailto:`, `tel:`) are ignored
- Server-absolute paths (`/{other-space}/...`) are reserved for v0.5 cross-space links — not emitted or resolved in v0
- Paths escaping the space root (`../../etc/passwd`) are dropped

Parsing uses a real HTML parser (`node-html-parser`), not regex — apostrophe-in-double-quote, malformed tags, and other edge cases work correctly.

There is no YAML frontmatter on wikis, no `[[wikilink]]` syntax, no placeholder rows. A link to a target that doesn't exist on disk is a **red link** — a `relationships` row with no matching `entities` row. Resolution is a LEFT JOIN at query time; surfaced via `GET /{space}/redlinks` and the `list_redlinks` agent tool.

Source files (anywhere outside `wiki/`) are indexed as `type='file'`. Markdown sources (`.md`) have their YAML frontmatter parsed into `properties` (the Augustine corpus pattern — `book: 5, section: 8`). Other source types (`.txt`, `.json`, `.csv`, `.xml`, `.rst`, `.html` outside `wiki/`) get only `{file_type: <ext>}`.

## Writing (the `writer` role)

A single agent role — `writer` — turns recent sources into HTML articles on a recurring cron schedule. Every tick, the writer:

1. Surveys two queues:
   - **Unprocessed sources**: `list_entities?type=file&inbound_max=0` — files no article cites yet
   - **Red links**: `list_redlinks` — link targets ranked by demand (how many existing articles want this concept defined)
2. Picks one piece of work: a high-demand red link, or a recently-arrived source.
3. Reads the relevant files (the source, or 1-2 articles that want the red-link target defined).
4. Articulates the driving question.
5. Searches existing articles via keyword search (`search(query=[...]&type=wiki)`).
6. Either **extends** the existing article via `edit_file` (`insert_at_line` or `str_replace`) or **creates** a new one via `create_file`.

Articles are horizontal: one article spans many sources, growing as the corpus grows. The default body convention is four sections — `<h2>Question</h2>` / `<h2>Current answer</h2>` / `<h2>Evidence</h2>` / `<h2>Open threads</h2>` — but it's a soft convention. Operators reshape it via `instructions:` in their `agents.yaml`.

The trigger is **purely cron-driven**. The watcher's job ends at the SQLite mirror; agents pick up new state at their next scheduled tick. Per-space serialization is enforced by an in-process mutex — at most one role can run in a given space at any time.

The bundled writer template ships `cron: "*/15 * * * *"` with `model: gpt-5.4-mini`, `reasoning_effort: low`, `max_steps: 12`. **First-run cost note**: a fresh `arkeon-wiki up` against a corpus with `OPENAI_API_KEY` set will start spending API credit within 15 minutes. Operators who want to inspect the writer's behavior before letting it run should override the cadence in `.arkeon/agents.yaml` (`cron: "0 0 31 2 *"` is the canonical "never fire" idiom — Feb 31 doesn't exist).

**Downtime → missed ticks are dropped.** No persistence of last-fire times. The cron model lets each role decide its own work from current state — new behaviors (reflector picking articles with open threads, bridger rotating across spaces) need only a different prompt + cron, no scheduler changes.

## Edit primitives

The writer's tool surface, validated by a 75-trial bake-off (see `tasks/v0-agent-harness-edit-primitives.md`):

- `read_file(path)` — returns line-numbered content (`<n>\t<line>`). Line numbers are reference-only — used with `insert_at_line` but never included in `str_replace` bytes. **Registers the path in the per-run read-gate.**
- `list_entities(...)` — filterable listing across wikis and sources.
- `list_redlinks(...)` — link targets without an entity row, aggregated by demand.
- `search(query, type?, ...)` — ripgrep keyword search; OR up to 10 patterns in one pass.
- `edit_file mode='insert_at_line' {path, line_number, content}` — pure additive insert BEFORE the given line. Lines shift down.
- `edit_file mode='str_replace' {path, old_string, new_string}` — exact-match SEARCH/REPLACE. `old_string` must match exactly once.
- `create_file(path, label, short_description, body)` — new wiki. Tool composes the HTML `<head>`/`<body>` envelope from the structured fields; path must start with `wiki/` and end in `.html`.
- `delete_wiki(path, reason)` — guarded full-file deletion (only `wiki/**`, required reason). Not in the writer's whitelist; available for operator scripts or future curator roles.

**The read-gate.** `edit_file` refuses to mutate a path the agent hasn't `read_file`-ed in this run. Successful edits invalidate the path — the agent must re-read before its next edit on the same file. This catches "editing from stale memory" errors before they corrupt a file. It lives on `AgentContext.readPaths` in `runtime.ts`.

`create_file` and `delete_wiki` are terminal and don't interact with the gate.

The read-gate is orthogonal to `edit-context.ts`, which exists for **attribution**: when `applyEdit` runs, it pushes the agent's role onto a process-global registry; `syncFile` reads it back so `entity_edits.by_role` carries the right value. Filesystem-driven syncs (a human editing a wiki in their editor) leave the registry empty and attribute to `'human'`.

## Schema

Six tables in SQLite, fresh `001-foundation.sql`:

- `spaces (name PK, watch_dir UNIQUE, created_at)`
- `entities (space_name, source_path)` composite PK, `type` CHECK (`'wiki'|'file'`), `label`, `source_hash`, `properties` JSON, timestamps
- `relationships (space_name, source_path, target_path)` composite PK, `link_text` — no FK on `target_path` (red links!)
- `entity_edits (space_name, entity_path, at)` composite PK — `at` carries millisecond precision via `strftime('%f')` so same-second writes don't collide. Not FK'd; history survives entity deletion.
- `conversations (id PK ULID, space_name, article_path NULLABLE, title)` — the **one** v0 table with an explicit ID, because conversations have no on-disk file to derive identity from. Phase 1 lays the schema; Phase 3 wires the routes.
- `conversation_messages (conversation_id, seq)` composite PK, `role`, `content` JSON

No auth, no actors, no versioning.

## Key modules

- `src/server/lib/sync.ts` — `syncFile()`: read a file, parse HTML wiki or markdown source, upsert entity, extract `<a href>` edges. Single-pass — relationships rows have no FK on `target_path` so out-of-order syncs resolve at query time.
- `src/server/lib/html-meta.ts` — `parseHtmlMeta(html)` → `{title, properties}`.
- `src/server/lib/html-links.ts` — `extractHtmlLinks(html, fromPath)` + `resolveHref(href, fromPath)`. Drops external URLs, server-absolute paths, fragments, escaping `..`.
- `src/server/lib/fs-watcher.ts` — `node:fs.watch` recursive + 500ms debounce, calls `syncFile()` on changes, `removeByPath()` on deletes. Also bootstraps the per-space agent scheduler.
- `src/server/lib/file-edits.ts` — `applyEdit(space, edit, opts)`: the mutation chokepoint. Four kinds: `create`, `insert_at_line`, `str_replace`, `delete`. Exports `composeWikiHtmlShell` for `create_file`.
- `src/server/lib/entities.ts` — `listEntities()` + `listRedLinks()` + `getEntity()`. Pure SQL, parameterized.
- `src/server/lib/search.ts` — ripgrep adapter (`@vscode/ripgrep`), spawns per-space, parses `--json` events, joins back to entities by path.
- `src/server/agents/` — declarative `.arkeon/agents.yaml` config (Zod-validated), bundled role templates (`templates/*.yaml`), role-builder, tool registry, `runAgent` loop (Vercel AI SDK), per-space cron scheduler.
- `src/server/agents/cron.ts` — `nextTick(expr, from)` via `cron-parser`. Drives the scheduler's `setTimeout` chain.
- `src/server/agents/scheduler.ts` — per-space cron. Per-space mutex (skip-if-busy on contention). No event queue, no orphan reclaim.
- `src/server/agents/space-scope.ts` — `resolveAllowedSpaces(scope, ownSpace)` + `resolveSpaceArg(arg, allowed)`. Multi-space reads, writes always to `ctx.space`.

## API endpoints

Routes are space-scoped under `/{space}/...`. No auth required.

- `GET /` — daemon-level landing (returns `{name, status}` for now; the human-facing version arrives in Phase 2).
- `POST /spaces` — register a directory. Body `{name, watch_dir}`. Name collisions return 409.
- `GET /spaces` — list spaces with entity counts.
- `GET /spaces/:name` — single space.
- `GET /{space}/entities?type=&label_contains=&path_contains=&inbound_min=&inbound_max=&outbound_min=&outbound_max=&updated_since=&edited_by_role=&sort=&limit=&offset=&include=` — listEntities scoped to one space.
- `GET /{space}/entities/*` — single entity by path (path is whatever follows `/entities/`). `?include=content` reads the file body from disk.
- `GET /{space}/redlinks?limit=&offset=` — red-link queue, ranked by `demand`. Each row carries `target_path`, `demand`, `linked_from` (last 3 source paths).
- `GET /{space}/recent?since=&role=&limit=&offset=` — `entity_edits` feed.
- `GET /{space}/search?q=&type=&limit=&snippets=&regex=` — keyword search via ripgrep. `q` repeatable up to 10 times to OR patterns.
- `POST /{space}/chat`, `GET /{space}/chat/:conversation_id`, `DELETE ...` — **501 Phase 1 stubs**, wired up in Phase 3.
- `GET /health` / `GET /ready` — liveness/readiness.

Content lives on disk — the API returns metadata, relationships, and (optionally) file bodies.

## Search

Filesystem-first keyword search via ripgrep (bundled via `@vscode/ripgrep`, cross-platform). For each space, spawns ripgrep with `--json`, parses match events into per-file results, and joins back to entities by `source_path`. Ranked by match count. There is no keyword index in SQLite — the filesystem is the index.

## Commands

```bash
arkeon-wiki up                       # start as a detached background daemon
arkeon-wiki down                     # stop the daemon (alias: stop)
arkeon-wiki status                   # is it running?
arkeon-wiki ls                       # list all running instances
arkeon-wiki logs [-f]                # print/tail the daemon log
arkeon-wiki init [name]              # register cwd as a space (default name = basename)
arkeon-wiki search <query> [--space <name>]
arkeon-wiki start                    # foreground (pm2/launchd/etc.)
```

Run multiple instances side by side with `--name`:

```bash
arkeon-wiki up --name dev-a          # state at ~/.arkeon-wiki/dev-a/, port derived from name
arkeon-wiki up --name dev-b          # independent daemon, different port
```

The port for a named instance is `8000 + sha256(name) mod 999 + 1`.

## Testing

```bash
npm run typecheck -w packages/arkeon    # type checking
npm test -w packages/arkeon             # unit tests
npm run test:e2e -w packages/arkeon     # e2e tests (spins up SQLite + API in-process)
```

E2e tests start a real stack in-process — no running daemon needed.

## State

- `~/.arkeon-wiki/` — default instance home (SQLite database, pidfile, log)
- `~/.arkeon-wiki/<name>/` — named instance home (one per `--name`)
- `~/.arkeon-wiki/<home>/data/arke.db` — the SQLite database file
- `~/.arkeon-wiki/<home>/arkeon.pid` — pidfile for the daemon
- `~/.arkeon-wiki/<home>/arkeon.log` — daemon stdout/stderr
- `~/.arkeon-wiki/instances/<name>.json` — registry of running instances
- `.arkeon/state.json` — per-directory space binding (`{api_url, space_name, created_at}`). The old `space_id` field is gone — names are PKs now.

Override the state dir with `ARKEON_WIKI_HOME` env var or `--data-dir`.

## Debugging agent runs

Agents emit verbose, human-readable logs to the daemon log unconditionally (`[agent/<role>/<level>] ...`). For *structured* per-event traces, set `ARKEON_WIKI_AGENT_TRACE=1`. Off by default.

When enabled, one JSON object per line is appended to `<arkeonHome>/agent-trace.jsonl` (override path with `ARKEON_WIKI_AGENT_TRACE_FILE`). Each event carries `ts`, `run_id`, `role`, `space_name`, `phase`, plus event-specific fields:

- `run.start` — phases planned, trigger path, allowed spaces
- `phase.start` / `phase.end` — model, tool whitelist, step count, token usage, duration
- `tool.call` / `tool.result` — args (truncated to 500 chars), per-tool `summary`, `duration_ms`, `ok`
- `edit` — path, edit_kind (`create | insert_at_line | str_replace | delete`)
- `run.end` / `run.error` — total steps, edits, usage, duration

Tail with `tail -f <path> | jq` or query with `jq -c 'select(.event=="tool.call" and .tool=="search")'`.

## Schema migrations

`src/schema/001-foundation.sql` is the v0 reset point — six tables, no migration history. The runner (`src/schema/migrate.ts`) tracks applied files in `schema_migrations` so future non-idempotent migrations only run once.

**Phase 1 migration story is destructive**: `rm ~/.arkeon-wiki/data/arke.db && arkeon-wiki up`. The database is a pure index — the only state that doesn't live on disk is `entity_edits`, and nobody is in production with audit history they care about.

## What's NOT here (yet)

- HTML reader / web viewer / chrome injection → **Phase 2** (`tasks/v0-reading-experience.md`)
- Chat-with-article → **Phase 3** (`tasks/v0-chat.md`). Schema is in place; routes are stubs.
- Cross-space link resolution — schema is ready (`relationships.target_path` is unconstrained text; URL scheme `/{other-space}/wiki/...` is committed). Writer prompt updates wait for **v0.5**.
- Vector / semantic search — returns at **v0.5** when corpus crosses ~2,000 articles.
- FTS5 / BM25 ranking (ripgrep gives substring matching only)
- No auth / API keys
- Move detection across content edits — a pure rename keeps inbound edges intact via the content-hash match in `recent-moves.ts`, but a rename combined with a content edit in the same save still orphans them
