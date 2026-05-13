# Agents guide — arkeon-wiki

If you're an AI coding assistant operating in this repo or in a directory bound to a running arkeon-wiki daemon, this is your toolbox. For human-oriented docs see [README.md](./README.md); for full architectural context see [CLAUDE.md](./CLAUDE.md).

## What arkeon-wiki is

A filesystem-first knowledge graph. A user points the daemon at one or more directories ("spaces"). The daemon watches files, parses HTML wikis under `wiki/`, walks `<a href>` links, and indexes everything into a local SQLite database keyed by `(space_name, source_path)`. The filesystem is the source of truth — SQLite is the index.

Six tables live in SQLite: `spaces`, `entities`, `relationships`, `entity_edits`, plus `conversations` + `conversation_messages` reserved for the Phase 3 chat surface. No auth, no queues, no actors. One process, one binary.

## CLI

Install: `npm install -g arkeon-wiki`. Then:

| Command | What it does |
|---|---|
| `arkeon-wiki up [--name <n>]` | Start the daemon as a detached background process. |
| `arkeon-wiki down [--name <n>]` | Stop the daemon. Alias: `stop`. |
| `arkeon-wiki status` | Show daemon state, port, and bound space (if any). |
| `arkeon-wiki ls` | List every running named instance. |
| `arkeon-wiki logs [-f]` | Print or tail the daemon log. |
| `arkeon-wiki init [name]` | Register the current directory as a space. Default name = directory basename. |
| `arkeon-wiki search <query> [--space <name>] [--limit N] [--snippets N] [--regex]` | Keyword search via ripgrep. Defaults to the bound space. |
| `arkeon-wiki start` | Foreground mode for use under pm2/launchd/systemd/docker. |

`--name <n>` runs a parallel instance with its own state dir at `~/.arkeon-wiki/<n>/` and a deterministic port (`8000 + sha256(name) mod 999 + 1`). Default instance lives at `~/.arkeon-wiki/`, port 8000.

## API

Default base URL: `http://localhost:8000`. No auth. JSON in, JSON out. Routes are space-scoped under `/{space}/...`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/spaces` | Register a directory. Body: `{ name, watch_dir }`. |
| `GET` | `/spaces` | List spaces with entity counts. |
| `GET` | `/spaces/:name` | Get a single space. |
| `GET` | `/{space}/entities?type=&label_contains=&path_contains=&inbound_min=&inbound_max=&outbound_min=&outbound_max=&updated_since=&edited_by_role=&sort=&limit=&offset=&include=` | List entities — wikis (`type=wiki`) and source files (`type=file`). `type` is a comma list. `include=counts` attaches `counts.inbound`/`counts.outbound`. `sort` is `updated_at` \| `label` \| `inbound` \| `outbound`. |
| `GET` | `/{space}/entities/*` | Properties + inbound/outbound relationships for one entity. Path is whatever follows `/entities/`. `?include=content` reads the file body. |
| `GET` | `/{space}/redlinks?limit=&offset=` | Link targets that don't have an entity row yet, aggregated by demand. Returns `{redlinks, total, limit, offset}` where each redlink has `target_path`, `demand` (number of pointers), `linked_from` (last 3 source paths). |
| `GET` | `/{space}/recent?since=&role=&limit=&offset=` | Audit-log feed from `entity_edits`. |
| `GET` | `/{space}/search?q=&type=&limit=&snippets=&regex=` | Ripgrep-backed keyword search within one space. |
| `POST` | `/{space}/chat` | **501 in Phase 1**. Wired up in Phase 3. |
| `GET` | `/{space}/chat/:conversation_id` | **501 in Phase 1**. |
| `DELETE` | `/{space}/chat/:conversation_id` | **501 in Phase 1**. |
| `GET` | `/health` | Liveness. |
| `GET` | `/ready` | Readiness — `200` if SQLite responds. |

The daemon also serves a small browser-facing reader (Phase 2). These return HTML, not JSON:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | HTML list of spaces + entity counts. |
| `GET` | `/{space}/` | HTML alphabetical article index (only `type='wiki'`). |
| `GET` | `/{space}/wiki/*` | The article HTML from disk, with `<div id="arkeon-chrome">` injected and link classes tagged (`arkeon-wiki`, `arkeon-file`, `arkeon-redlink`). |
| `GET` | `/{space}/*` | Static-file fallback (sources, PDFs, images, …) with the right `Content-Type`. |

URL structure mirrors disk structure: `wiki/foo.html` on disk → `/{space}/wiki/foo.html` over HTTP. Articles also work directly over `file://` because hrefs are never rewritten.

## Wiki file format

Wikis are HTML under `wiki/` (subfolders allowed for organization, no `subject_type` namespacing). The shell:

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
  <p>Occurs inside <a href="../wiki/chloroplast.html">chloroplasts</a> and uses
     <a href="biology/chlorophyll.html">chlorophyll</a>.</p>
</body>
</html>
```

Sync extracts:
- `<title>` → `entities.label`
- Every `<meta name="X" content="Y">` → `properties[X] = Y` (JSON map)
- Every `<a href>` → a row in `relationships` with `target_path` resolved relative to the article's directory. External URLs are ignored. Server-absolute paths (`/{other-space}/...`) are reserved for v0.5 cross-space links — not emitted in v0.

There is no YAML frontmatter on wikis, no `[[wikilink]]` syntax, no placeholder rows. A link to a target that doesn't exist on disk is a **red link** — a `relationships` row with no matching `entities` row. Surfaced via `/{space}/redlinks` and the `list_redlinks` tool.

Source files (anywhere outside `wiki/`) are indexed as `type='file'` with `{file_type: <ext>}`. Supported extensions: `txt`, `json`, `html` outside `wiki/`, `csv`, `xml`, `rst`. Markdown is intentionally unsupported — HTML is the only authoring format. Structured metadata belongs on `<meta name="...">` tags inside the wiki.

## How to query the graph from an AI session

In a directory bound to a running daemon (`.arkeon/state.json` exists), use the bound space name:

```bash
SPACE=$(jq -r .space_name .arkeon/state.json)
API=$(jq -r .api_url .arkeon/state.json)

# Find articles that mention "shannon"
curl "$API/$SPACE/search?q=shannon"

# Pull a wiki + its relationships
curl "$API/$SPACE/entities/wiki/photosynthesis.html"

# Pull its file body
curl "$API/$SPACE/entities/wiki/photosynthesis.html?include=content"

# What targets are missing? (next thing to write)
curl "$API/$SPACE/redlinks?limit=20"

# Source files no wiki cites yet
curl "$API/$SPACE/entities?type=file&inbound_max=0&include=counts"
```

## The editor, proposer, and writer agents

Three bundled roles share the writing job, each with a single responsibility:

- **`editor`** (`templates/editor.yaml`, cron `0 */1 * * *`) — source-driven. Picks one source the editor hasn't tagged at its current `source_hash`, surveys existing articles via `list_entities` + `properties.short_description`, and for each article the source bears on, either (a) inserts a citation-bearing paragraph into Evidence / revises the Current Answer via `edit_file`, or (b) appends a red-link `<li>` to the article's `<h2>Open threads</h2>`. Tags the source `editor.processed_hash=<source_hash>` when done. Never creates new articles.

- **`proposer`** (`templates/proposer.yaml`, cron `0 */1 * * *`) — also source-driven, but **data-gated on the editor's tag**: picks one source where `has_tag=editor.processed_hash AND not_has_tag=proposer.processed_hash`. Calls `get_entity` on the source path to see which articles the editor already integrated this source into (`entity.inbound`). Identifies the GAP — questions the source raises that no existing article (and no queued red link) covers. Writes a plan wiki at `wiki/_plans/<source-path>.html` listing those gaps as red links. Tags the source `proposer.processed_hash=<source_hash>`. Never edits existing articles, never writes article bodies.

- **`writer`** (`templates/writer.yaml`, cron `*/15 * * * *`) — red-link-driven. Picks the highest-demand entry from `list_redlinks`, follows its linkers back to source files, and creates the article via `create_file`. Only ever creates — `edit_file` is not in its whitelist. Empty red-link queue → no-op, no fallback "invent something" branch.

The pipeline is **sequential per source** by data dependency: editor marks → proposer eligible to run → both contribute red links → writer drains them. Content changes invalidate both source markers so the source re-enters both queues automatically.

Two tagging patterns coexist on the `entities.tags` JSON column:

- **Processing markers** (the canonical "I did this" idiom): `mark_processed(path, role)` writes `tags["${role}.processed_hash"] = source_hash` on the server side. The agent never touches the hash. Query queues with `list_entities({ tag_outdated: "<role>.processed_hash" })` (needs processing — absent OR stale) or `tag_current: "<role>.processed_hash"` (processed at current content). Hash invalidation is automatic.
- **Free-form state** (for future roles that need richer bookkeeping — categorization, status enums, severities): use `tag_entity(path, key, value)` and the existing `has_tag` / `not_has_tag` / `tag_equals` filters. Not hash-validated; the agent is responsible for re-tagging when content changes if that matters.

Default model for all three: `gpt-5.4-mini`, `reasoning_effort: low`. The single-role-per-tick decomposition lets a small model handle each job reliably (the previous single-writer role needed `reasoning_effort: medium` for the integrated workload). Override per role in `.arkeon/agents.yaml` for a stronger model or different cadence.

**First-run cost**: a fresh `arkeon-wiki up` against a corpus with `OPENAI_API_KEY` set will start spending API credit within 15 minutes. Override the cadence in `.arkeon/agents.yaml` (`cron: "0 0 31 2 *"` is the canonical "never fire") to inspect behavior before letting it run.

## Constraints to be aware of

- **No auth.** Anyone who can reach the port can read and delete. Designed for `localhost`.
- **Filesystem is truth.** Don't `INSERT` into SQLite directly — your changes will be overwritten on the next reconciliation.
- **Keyword-only search.** No vector / semantic search in v0. Returns when corpus crosses ~2,000 articles.
- **One package, one process.** The CLI and server are the same binary. Use `--name` to keep parallel instances separate.
- **Renames become red links.** Deleting `foo.html` (whether genuinely or as half of a rename) leaves every existing `<a href="foo.html">` in other articles pointing at a missing target — the index reflects that as a red link, ranked into the writer's queue. Filesystem is truth, so the index never rewrites links the articles themselves still spell the old way; a real rename is an explicit, file-editing operation that updates the source articles' hrefs.

## Pointers for working on the codebase itself

- `packages/arkeon/src/server/lib/sync.ts` — read a file, upsert an entity, extract `<a href>` edges. The single chokepoint between filesystem and database.
- `packages/arkeon/src/server/lib/html-meta.ts` — `<title>` + `<meta>` extraction (real HTML parser, not regex).
- `packages/arkeon/src/server/lib/html-links.ts` — `<a href>` walker + relative-path resolver.
- `packages/arkeon/src/server/lib/file-edits.ts` — the mutation chokepoint: `create`, `insert_at_line`, `str_replace`, `delete`.
- `packages/arkeon/src/server/agents/tools.ts` — the tool registry. The read-gate (`AgentContext.readPaths`) lives in `runtime.ts`.
- `packages/arkeon/src/schema/001-foundation.sql` — the entire schema (6 tables).
