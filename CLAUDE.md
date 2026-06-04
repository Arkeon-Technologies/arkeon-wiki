# arkeon-wiki

Filesystem-first **substrate** for agent harnesses. Point the daemon at one directory; it watches files, indexes them into SQLite, and exposes a small JSON API. External harnesses (Hermes, OpenClaw, Claude Code, custom) own the agent loop. Arkeon is just the substrate.

**Repo**: `Arkeon-Technologies/arkeon-wiki` (branch: `main`)

## How it works

1. `arkeon-wiki up --watch-dir ~/work/corpus` — starts SQLite + API server as a detached background daemon, watching a single root.
2. You add/edit/delete files anywhere under the watched root — the watcher syncs to SQLite automatically.
3. HTML files use `<title>` + `<meta>` tags for metadata. `<a class="wikilink" href="./X">` anchors become link rows with optional `data-*` citation metadata.
4. Markdown `[[X]]` syntax also produces link rows (shortest-unique-basename resolution).
5. Binary files (PDFs today) auto-extract to HTML sidecars under `.sidecars/<mirrored-path>.html`.

The filesystem is the source of truth. SQLite is the index. There is no write API — drop a file in the watched root and the watcher indexes it.

## Project structure

One npm workspace, published as `arkeon-wiki` on npm.

- `packages/arkeon/` — the main package.
  - `src/index.ts` — CLI entry (commander).
  - `src/cli/commands/local/` — daemon lifecycle (up, down, start, stop, status, ls, logs, install, uninstall, install-deps).
  - `src/cli/lib/` — instances registry, paths, service install helpers.
  - `src/server/app.ts` — Hono app with the substrate routes.
  - `src/server/server.ts` — API startup, watcher wiring.
  - `src/server/routes/` — `space-scoped.ts` (the six commands), `reader.ts` (directory browser).
  - `src/server/lib/` — sync, entities, fs-watcher, html-links, md-links, reader, path, html-meta, sql.
  - `src/server/extractors/` — PDF → HTML sidecar pipeline (PyMuPDF via managed Python venv).
  - `src/schema/` — `001-foundation.sql` (artifacts/tags/links/fts_artifacts) + migrate runner.

## Data model

Four tables in SQLite:

- `artifacts (path PK, kind, label, source_hash, stat_fingerprint, properties, created_at, updated_at)`
  - `kind='text'` for HTML / MD / source text / binary sidecar HTMLs.
  - `kind='asset'` for binaries — linkable, but outside FTS5.
- `tags (path, key, value, PK(path, key))` — agent-applied bookkeeping. `(path, key)` is PK, so each artifact carries at most one value per key. Two conventions: **worker gates** use one key per worker (`processed-by-editor`, `processed-by-writer`) so multiple workers coexist; **content labels** use `key:value` strings (`status:feedback`, `topic:us-china`) where the value carries meaning.
- `links (id PK, source_path, target_path, link_text, attrs JSON, synced_at)` — every `<a class="wikilink">` or `[[X]]` the extractor resolved. `attrs` is JSON of `data-*` citation metadata. `synced_at` is per-row last-sync timestamp (not first-anchor-creation: rows get DELETE+INSERTed on every source re-extraction).
- `fts_artifacts (path UNINDEXED, text)` — FTS5 over text-kind artifact contents. Populated by `syncFile`.

No `space_name` column; no spaces table. Top-level subdirectories of the watched root are conventionally "spaces" (e.g. `iarpa/`, `chartbook/`) but the daemon treats them as path prefixes only.

## Link conventions

**HTML**: `<a class="wikilink" href="./topic-x">topic X</a>`. The `wikilink` class is what marks it as a graph edge. Other `<a>` elements render as ordinary HTML.

**Markdown**: `[[X]]` resolves by shortest-unique-basename match against the artifact index. `[[folder/X]]` works for disambiguation. `[[X|Display Name]]` carries an alias.

**Citation metadata**: every `data-*` attribute on a wikilink lands in `links.attrs` JSON with the `data-` prefix STRIPPED (so `data-quote` → `attrs.quote`, `data-cite-type` → `attrs["cite-type"]`):

```html
<a class="wikilink"
   href="./paper.pdf.html"
   data-quote="On March 5th I instructed..."
   data-page="3"
   data-cite-type="evidence">paper</a>
```

Wikilink hrefs resolve relative to the source file's directory: `./sources/x.pdf` from `iarpa/y.html` → `iarpa/sources/x.pdf`. MD `[[X]]` redlinks converge automatically: if `[[X]]` is written before its target exists, the link row stays as the literal slug, then gets rewritten to the resolved path once the target lands (during initial reconcile or via a live watcher event).

## Reader

Catch-all directory browser:

- `GET /` → directory listing of the watched root.
- `GET /<path>/` → directory listing of any subfolder.
- `GET /<path>` → file serve. HTML files run through wikilink rewriting; unresolved `<a class="wikilink">` anchors gain a `redlink` class so CSS can style them.

URL structure mirrors disk structure. The same article opens identically under `file://` and `http://` (apart from the redlink class injection).

## HTTP API — six commands

All POST bodies are JSON; all GET params are URL-encoded.

- `POST /query` — `{folder?, kinds?, has_tag?[], not_tag?[], has_property?[], not_property?[], text?, limit?, offset?}`. AND-composed. `has_tag` / `not_tag` / `has_property` / `not_property` entries are `"key"` (presence) or `"key:value"` (key+value match). `has_property` / `not_property` target `artifacts.properties` (HTML `<meta>` values, plus substrate-set `sidecar_path` on primary binaries and `derived_from` on extractor-produced assets — `kinds:["asset"], not_property:["derived_from"]` lists primary binaries only). `text` runs FTS5 MATCH.
- `POST /tag` — `{path, key, value?}`. UPSERT. Returns `{ok, path, key, value, previous_value, action}` where `action` is `created` / `updated` / `unchanged`. Workers detect collisions by inspecting `previous_value`.
- `POST /untag` — `{path, key}`. Returns `{ok: true, path, key, existed}` where `existed` distinguishes a real deletion from a no-op (removing a non-existent tag is not an error).
- `GET /tags?path=...` — `{path, tags: Record<key,value>}`.
- `GET /backlinks?path=...` — inbound link rows with `attrs` JSON. Returns `{path, exists, demand, backlinks: [...]}` and works uniformly whether `path` is a real artifact or a redlink target; `exists` tells you which. One row per anchor (multi-citation preserved). For "what unresolved targets exist?" use `/redlinks` — the aggregated complement.
- `GET /redlinks?folder=&limit=&offset=` — unresolved targets, ranked by demand. The work-to-be-written queue.

## Trigger model

External harnesses do the agent loop. Pattern per worker:

1. `POST /query` with `not_tag: ["processed-by-<worker-name>"]` and whatever `kinds` / `has_tag` filters fit the worker.
2. Read each artifact via filesystem.
3. Write outputs via filesystem (drops in the watched root → watcher indexes).
4. `POST /tag` with `{ key: "processed-by-<worker-name>", value: <hash-or-ts> }` so the same artifact isn't re-picked next tick.

"No tag = unprocessed" — new files surface naturally because they lack the worker's `processed-by-*` tag.

**Don't reach for `folder` when scoping a worker.** PDF/Word sidecars live at `.sidecars/<mirrored>.html`, OUTSIDE the source folder. A `folder: "iarpa/sources"` query misses every binary's sidecar. Use the tag gate alone — `kinds: ["text"], not_tag: ["processed-by-<worker>"]` covers both source files and sidecars.

## Sidecars

Binary files generate HTML sidecars at `.sidecars/<mirrored-path>.html`. The sidecar is indexed as `kind='text'` and feeds FTS5. The binary itself is also indexed (as `kind='asset'`) so wikilinks to it resolve. The asset's `properties.sidecar_path` carries the convention path so harnesses can dereference it without hard-coding `.sidecars/`.

**Tag the sidecar, not the binary.** Worker `processed-by-<name>` tags belong on the sidecar (the `kind='text'` row), not the asset. Asset artifacts are invisible to any `kinds: ["text"]` query — tagging them does nothing the next tick will notice. Use `asset.properties.sidecar_path` to find the right target.

PDF extraction uses PyMuPDF via the Python venv baked into the Docker image (`/opt/arkeon-wiki/python`). On the npm-distribution path there is no binary extractor support — PDFs index as `kind='asset'` (linkable) but no sidecar is produced.

Adding a new handler: drop a module under `src/server/extractors/<format>.ts` exporting a `FileHandler` (extensions, declarative `dependencies`, async `extract`), register it in `index.ts`'s `HANDLERS` array, add a fixture, and add the corresponding system package or Python wheel to the `Dockerfile` runtime stage.

## Commands

### Daemon lifecycle

```bash
arkeon-wiki up --watch-dir <path>   # start daemon watching <path>
arkeon-wiki down                    # stop daemon
arkeon-wiki status                  # is it running?
arkeon-wiki ls                      # list running instances
arkeon-wiki where                   # which instance owns this directory?
arkeon-wiki logs [-f]               # tail daemon log
arkeon-wiki start                   # foreground (for pm2/launchd/Docker)
arkeon-wiki install                 # persistent service
arkeon-wiki uninstall               # remove service
```

`arkeon-wiki install-deps` has been removed — binary extractor dependencies (PyMuPDF, future libreoffice/pandoc/tesseract) now ship in the Docker image only. The command stub remains so legacy scripts fail loudly with a pointer to the image.

### Substrate API (one CLI command per HTTP endpoint)

Every command below is a thin wrapper over the HTTP API — no SQLite direct reads, no caching. If stdout is a TTY they pretty-print; if piped they emit the raw JSON response (so `arkeon-wiki query | jq` works).

```bash
arkeon-wiki query [--folder X --kinds text --has-tag K[:V] --not-tag K --text Q ...]
arkeon-wiki tag <path> <key>[=<value>]   # UPSERT — = and value optional
arkeon-wiki untag <path> <key>
arkeon-wiki tags <path>                  # list every tag on an artifact
arkeon-wiki backlinks <path>             # inbound link rows (works for redlinks too)
arkeon-wiki redlinks [--folder X --limit N --offset N]
arkeon-wiki stats                        # corpus-level counts
```

Reading article bodies is *not* a CLI command — the filesystem is the read API. `cat`, `bat`, `$EDITOR` work fine; the daemon's job is the index, not the read path.

### Daemon resolution

Every substrate-API command picks a daemon in this order:

1. `--api-url <url>`
2. `ARKEON_WIKI_URL` env
3. `--name <inst>` (looks up `~/.arkeon-wiki/instances/<inst>.json`)
4. CWD walk — deepest registered `watch_dir` containing `process.cwd()` wins
5. `default` instance

Run `arkeon-wiki where` from inside a watched corpus to see which instance the CLI will hit. Exit code is `0` for success, `1` for HTTP 4xx/5xx, `2` for network errors.

## Docker image

Published to `ghcr.io/arkeon-technologies/arkeon-wiki` on every push to `main` (`:main`, `:sha-<short>`) and on `arkeon-wiki-v*` tags (`:vX.Y.Z`, `:latest`). The image bakes the Python venv with PyMuPDF at `/opt/arkeon-wiki/python` and an adapters manifest at `/opt/arkeon-wiki/adapters.json` (path overridable via `ARKEON_WIKI_ADAPTERS_PATH`).

Volumes: `/watch` (corpus bind mount) and `/state` (`ARKEON_WIKI_HOME`). Default port 8062. The entrypoint remaps the in-container `arkeon` user to `PUID`/`PGID` so writes into `/state` match the host's expected owner. See `docker-compose.example.yml` for a starter.

`--name <name>` enables multiple instances side by side.

## Persistent service (macOS launchd / Linux systemd)

`arkeon-wiki install` registers the daemon with the platform's service supervisor so it starts at login and restarts on crash.

- **macOS**: writes `~/Library/LaunchAgents/tech.arkeon.wiki[.<name>].plist`.
- **Linux**: writes `~/.config/systemd/user/arkeon-wiki[-<name>].service`, enables linger via `loginctl enable-linger` (best-effort). Requires systemd 240+.

When a service is installed, `up` / `down` / `status` coordinate with the supervisor instead of fighting it.

## Testing

```bash
npm run typecheck -w packages/arkeon
npm test -w packages/arkeon
npm run test:e2e -w packages/arkeon
```

E2e tests spin up the API in-process against a temp watched root.

## State

- `~/.arkeon-wiki/` — default instance home (DB, pidfile, log).
- `~/.arkeon-wiki/<name>/` — named instance home.
- `~/.arkeon-wiki/.env` — user-global env file (write API keys here if needed; the substrate itself has no auth).
- `~/.arkeon-wiki/adapters.json` — versioned manifest of resolved extractor dependencies. In the Docker image this lives at `/opt/arkeon-wiki/adapters.json` and is selected via `ARKEON_WIKI_ADAPTERS_PATH`.

Override the state dir with `ARKEON_WIKI_HOME` env var or `--data-dir`. Override the watched root with `ARKEON_WIKI_WATCH_DIR` or `--watch-dir`.

## Bind posture

The API binds to `127.0.0.1` by default — loopback only. Override with `ARKEON_WIKI_HOST=0.0.0.0` to expose cross-host. There is no auth yet; deferred until customer demand.

## Schema migrations

`src/schema/001-foundation.sql` is the substrate reset point. The DB is a pure index of filesystem state; if anything corrupts, `rm ~/.arkeon-wiki/data/arke.db && arkeon-wiki up` rebuilds the index from disk in seconds.

`json_extract` / `json_each` and FTS5 require SQLite 3.38+. better-sqlite3 bundles SQLite, so this is satisfied at the application level.

## What's NOT here (yet)

- **Agent runtime** — external harnesses own the loop. Arkeon doesn't ship agents.
- **Write API** — no `POST /inbox`, no `PUT /sources/*`. Writes go through the filesystem.
- **Auth** — deferred until a customer shape demands it.
- **DOCX / EML extractors** — only PDF today; the handler interface is in place for more.
- **Quote integrity validation** (`data-quote` exists in target).
- **Rename handling** for backlinks (rename = redlinks on the new path until the inbound articles get updated).
