# Agents guide — arkeon-wiki

If you're an AI coding assistant operating in this repo or in a directory bound to a running arkeon-wiki daemon, this is your toolbox. For human-oriented docs see [README.md](./README.md); for full architectural context see [CLAUDE.md](./CLAUDE.md).

## What arkeon-wiki is

A filesystem-first knowledge graph. A user points the daemon at one or more directories ("spaces"). The daemon watches files, parses HTML wikis under `wiki/` and any markdown sources, walks `<a href>` links, and indexes everything into a local SQLite database keyed by `(space_name, source_path)`. The filesystem is the source of truth — SQLite is the index.

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

Source files (anywhere outside `wiki/`) are indexed as `type='file'`. Markdown sources with YAML frontmatter have their frontmatter parsed into `properties`. Other source types (txt, json, html outside `wiki/`, csv, xml, rst) get only `{file_type: <ext>}`.

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

## The writer agent

The bundled `writer` role (`packages/arkeon/src/server/agents/templates/writer.yaml`) runs on a cron schedule (`*/15 * * * *` by default). Each tick it:

1. Surveys two queues: unprocessed sources (`list_entities?type=file&inbound_max=0`) and red links (`list_redlinks`).
2. Reads the most interesting source or 1-2 of the articles that want a red-link target defined.
3. Articulates the driving question.
4. Searches for an existing article addressing it.
5. Either **extends** the existing article via `edit_file` (`insert_at_line` or `str_replace`, both read-gated) or **creates** a new one via `create_file` (HTML shell composed from `label` + `short_description` + `body`).

Default model: `gpt-5.4-mini`, `reasoning_effort: low`. Override via `.arkeon/agents.yaml` if you want a different model or schedule.

**First-run cost**: a fresh `arkeon-wiki up` against a corpus with `OPENAI_API_KEY` set will start spending API credit within 15 minutes. Override the cadence in `.arkeon/agents.yaml` (`cron: "0 0 31 2 *"` is the canonical "never fire") to inspect behavior before letting it run.

## Constraints to be aware of

- **No auth.** Anyone who can reach the port can read and delete. Designed for `localhost`.
- **Filesystem is truth.** Don't `INSERT` into SQLite directly — your changes will be overwritten on the next reconciliation.
- **Keyword-only search.** No vector / semantic search in v0. Returns when corpus crosses ~2,000 articles.
- **One package, one process.** The CLI and server are the same binary. Use `--name` to keep parallel instances separate.
- **Renames keep inbound links** if the content is byte-identical. Watchers see `unlink`+`add` events within a short window; if the new file's content hash matches the deleted one (in the same space), sync automatically rewires inbound edges from the old path to the new. A rename + content edit in the same save would still orphan the edges — but a pure rename works without the redlinks queue surfacing it.

## Pointers for working on the codebase itself

- `packages/arkeon/src/server/lib/sync.ts` — read a file, upsert an entity, extract `<a href>` edges. The single chokepoint between filesystem and database.
- `packages/arkeon/src/server/lib/html-meta.ts` — `<title>` + `<meta>` extraction (real HTML parser, not regex).
- `packages/arkeon/src/server/lib/html-links.ts` — `<a href>` walker + relative-path resolver.
- `packages/arkeon/src/server/lib/file-edits.ts` — the mutation chokepoint: `create`, `insert_at_line`, `str_replace`, `delete`.
- `packages/arkeon/src/server/agents/tools.ts` — the tool registry. The read-gate (`AgentContext.readPaths`) lives in `runtime.ts`.
- `packages/arkeon/src/schema/001-foundation.sql` — the entire schema (6 tables).
