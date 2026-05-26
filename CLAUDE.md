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

Files (anywhere outside `wiki/`) are indexed as `type='file'`. Eligibility is a small denylist (`SKIP_EXTENSIONS` for secrets and editor scratch — `.env`, `.pem`, `.swp`, `.tmp`, …; `SKIP_BASENAMES` for OS junk — `.DS_Store`, `Thumbs.db`). Everything else gets an entity row. Classification into kind happens in `classifyFile()` (`src/server/lib/fs-watcher.ts`): `TEXT_EXTENSIONS` allowlist → `kind='text'`; `ASSET_EXTENSIONS` allowlist → `kind='asset'`; unknown extension → sniff first 8 KB, no NUL → text, otherwise asset.

`kind='text'` is what enters the agent queues. Wikis are always text. Source files classified as text get parsed (HTML wikis emit `<a href>` edges; other text files just record `file_type`). Queue queries in editor / proposer / connector pass `kind='text'` so attachments stay out of the work feed.

`kind='asset'` covers everything binary — images, PDFs, audio, video, archives, fonts, office documents. Asset rows exist so `<a href="report.pdf">` and `<img src="chart.png">` inside wikis resolve as real links instead of red links — they're addressable but never feed the agents. Asset rows carry `{file_type, size_bytes}` in `properties`, no parsed metadata, no link extraction, no `entity_edits` audit rows. `properties.size_bytes` is the only column on an asset that isn't on a text row.

**Change detection.** `source_hash` is canonical SHA-256 of content for both kinds — uniform meaning across the codebase. Alongside it, `stat_fingerprint` (`mtime_ms-size_bytes`) is a cheap cache: if the fingerprint matches the stored value, the bytes are guaranteed unchanged and `syncFile` skips the content read entirely. On a fingerprint miss it computes the real content hash (streaming for assets so multi-GB files don't try to fit in RAM); if the hash matches `source_hash`, the change was a touch (refresh fingerprint, no parse, no `updated_at` bump). This keeps `source_hash` semantically uniform while making syncs O(1) on unchanged files — particularly load-bearing for large assets during a reconcile walk.

Wikis themselves are still authored in HTML only — the eligibility rules above are for *source* material the agents read. Structured metadata lives in `<meta name="X" content="Y">` tags on the wiki itself.

## Writing (three roles: `editor`, `proposer`, `writer`)

Three bundled agent roles cooperate on a single-job-each pipeline. Each runs on its own cron, all three serialized per-space by the in-process mutex.

**`editor`** (source-driven, runs first per source). Each tick:
1. Picks one source the editor hasn't tagged at its current `source_hash` (`list_entities?type=file&kind=text&not_has_tag=editor.processed_hash`).
2. Reads the source; surveys existing articles via `list_entities` (using `properties.short_description` for semantic matching).
3. For each existing article the source bears on, applies one or both:
   - **Content edit** — `edit_file insert_at_line` adds a citation-bearing paragraph in Evidence, or `edit_file str_replace` revises Current Answer when the source reshapes the thesis. Always cites the source inline via `<a href="../sources/...">`.
   - **Open-thread red link** — `edit_file insert_at_line` appends one `<li>` to the article's `<h2>Open threads</h2>` `<ul>`, containing a red link to a future article and a one-sentence gloss.
4. `tag_entity` the source with `key="editor.processed_hash"` value=source_hash.

Editor never creates articles. Zero edits per tick is fine — many sources are tangential to existing articles and should be tagged-and-skipped.

**`proposer`** (source-driven, runs SECOND per source by data dependency). Each tick:
1. Picks one source the editor has tagged but the proposer hasn't (`list_entities?type=file&kind=text&has_tag=editor.processed_hash&not_has_tag=proposer.processed_hash`).
2. Reads the source.
3. **Calls `get_entity` on the source path** — `entity.inbound` lists every article that already cites this source (the editor's integration points). These tell the proposer which concepts the editor already integrated.
4. **Searches the broader corpus** for thematically-adjacent material on the source's main themes — so the plan can seed cross-source citations the writer will follow later. Without this step plans tend to cite only their originating source, which biases the writer toward single-source articles.
5. Identifies the GAP — questions the source raises that aren't already covered by (a) an existing article citing this source, (b) any other existing article, or (c) an already-queued red link.
6. `create_file` a plan wiki at `wiki/_plans/<source-path>.html` (mirrors source path, drops extension to `.html`) containing a Summary that cites the source inline plus any cross-source parallels found in step 4, plus a list of red links to the gap articles. `<meta name="kind" content="plan">` distinguishes plan wikis from real articles.
7. `tag_entity` the source with `key="proposer.processed_hash"` value=source_hash.

Proposer never edits existing articles and never writes article bodies — only red-link slugs in a plan wiki.

**`writer`** (red-link-driven). Each tick:
1. Picks the highest-demand entry from `list_redlinks`.
2. Reads the 1-3 plan wikis / articles that linked at it (via `linked_from` + `get_entity`), then follows their inline `<a href="../sources/...">` citations back to the source files.
3. **Searches the broader corpus by default** for adjacent material on the question's central concept and reads whatever the plan didn't already point at. Single-source articles are an explicit escape hatch (justified in the one-line reply), not the default — most questions are richer when the article cites multiple sources.
4. `create_file` the new article at the red link's `target_path`. Standard four-section body (`Question` / `Current answer` / `Evidence` / `Open threads`) with inline source citations. Drops 1-2 forward-looking red links in Open Threads to keep the queue alive.

Writer **only creates new articles**. No `edit_file` in its whitelist; no fallback "write from scratch when queue is empty" branch — empty queue → no-op.

**Tag namespaces** are the queue mechanism: `editor.processed_hash` / `proposer.processed_hash` on each source. Content changes (new `source_hash`) naturally invalidate both, re-entering the source into both queues.

The trigger for all three is **purely cron-driven**. Bundled defaults: editor hourly, proposer hourly (gates on editor's tag so it naturally trails one cycle), writer every 15 min. Per-space mutex serializes — at most one role runs in a given space at a time. Cron ticks **queue** behind any in-flight or already-queued run in their space (FIFO), so a contended tick is never dropped — it just runs late. Manual `POST /:space/agents/:role/run` calls keep fail-fast semantics: 409 if the space is busy or has a queued waiter.

All three bundled templates ship with `model: gpt-5.4-mini`, `reasoning_effort: low`. **First-run cost note**: a fresh `arkeon-wiki up` against a corpus with `OPENAI_API_KEY` set will start spending API credit within 15 minutes. To inspect behavior before letting them run, override the cadence per role in `.arkeon/agents.yaml`.

**Downtime → missed ticks are dropped.** No persistence of last-fire times. The cron model lets each role decide its own work from current state — new behaviors (synthesizer connecting articles across themes, deprecator marking stale questions) need only a different prompt + cron, no scheduler changes.

## Edit primitives

The writer's tool surface, validated by a 75-trial bake-off (see `tasks/v0-agent-harness-edit-primitives.md`):

- `read_file(path)` — returns line-numbered content (`<n>\t<line>`). Line numbers are reference-only — used with `insert_at_line` but never included in `str_replace` bytes. **Registers the path in the per-run read-gate.**
- `list_entities(...)` — filterable listing across wikis and sources.
- `list_redlinks(...)` — link targets without an entity row, aggregated by demand.
- `search(query, type?, ...)` — ripgrep keyword search; OR up to 10 patterns in one pass.
- `edit_file mode='insert_at_line' {path, line_number, content}` — pure additive insert BEFORE the given line. Lines shift down.
- `edit_file mode='str_replace' {path, old_string, new_string}` — exact-match SEARCH/REPLACE. `old_string` must match exactly once.
- `create_file(path, html)` — new wiki from a complete HTML document. Path must start with `wiki/` and end in `.html`. `html` must begin with `<!DOCTYPE>` or `<html>` and contain a non-empty `<title>` plus a `<body>`. The agent authors the whole document, envelope and all — symmetric with how a human writes a wiki. Recommended (not enforced): `<meta name="label">` and `<meta name="short_description">`. Any other `<meta name="...">` tags land in `entities.properties`. Each validation failure returns the canonical template inline so the model can retry in one shot.
- `delete_wiki(path, reason)` — guarded full-file deletion (only `wiki/**`, required reason). Not in the writer's whitelist; available for operator scripts or future curator roles.
- `tag_entity(path, key, value)` — set or clear an agent-applied tag on any entity (wiki or source). Writes to `entities.tags`, a JSON bag distinct from `properties` (see "Properties vs tags" below). Pass `null` as `value` to delete the key (empty string is a legitimate value and is stored verbatim). Idempotent. No read-gate interaction — tags aren't file content.
- `fetch(targets[], space?)` — batched URL + local-path reader. Dispatches each target on `^https?://` (remote) vs path (local, resolved against the space's watch_dir). For universal-image MIMEs (PNG/JPEG/WebP/GIF) the bytes are pushed onto `ctx.imageQueue` keyed by `toolCallId`; the runtime's `prepareStep` wrapper drains the queue between steps and splices a synthetic `assistant("Reviewing the fetched content.")` + `user([text, image, …])` into the conversation. Text MIMEs are returned inline (32 KB cap). Other formats (PDF, SVG, archives) return structured error stubs. Local text reads register in the read-gate so a subsequent `edit_file` works without re-reading. Per-target failures don't abort the batch.
- `inbox(text, title?, kind?)` — drop a free-text note into the source corpus for a future tick to consider. Writes to `sources/inbox/<UTC-date>/<slug>.<md|txt>` via the same `resolveInboxPath` / `buildInboxContent` helpers backing `POST /:space/inbox`. Slug from `title` (slugified, ASCII kebab) or a 10-char ULID prefix; collisions auto-suffix `-2`, `-3`. `kind: "md"` (default) with a title prepends `# <title>`; otherwise verbatim. Always writes to `ctx.space`; the new entity has no `*.processed_hash` tag so the editor picks it up on the next tick.
- `add_source(url)` — download an HTTP(S) URL's bytes into `sources/inbox/<UTC-date>/<filename>` so a later editor / proposer tick processes it. Filename resolves from Content-Disposition → URL basename → ULID fallback; extension must be on the allowlist (`.pdf .html .htm .md .markdown .txt .json .xml .csv .png .jpg .jpeg .webp .gif`) or returns `{error: 'unsupported_media_type'}`. Goes through `applyEdit` (extended to accept `Buffer` for binary writes), so the audit row carries the agent's role. PDFs and images land as `kind='asset'` (addressable for citations but outside the editor queue today — extraction is `tasks/v0-binary-ingestion.md`); text MIMEs land as `kind='text'` and enter the queue. Shares the operator kill switch (`ARKEON_WIKI_FETCH_DISABLED`) and byte cap (`ARKEON_WIKI_FETCH_MAX_BYTES`, default 25 MB) with `fetch`.

**The portable image-injection pattern.** Only Anthropic's native provider accepts images in `tool`-role messages — OpenAI, Gemini, and every OpenAI-compatible open-source endpoint require images in `user` messages. The `prepareStep` wrapper (`makeImageInjectionPrepareStep` in `runtime.ts`) translates: tool returns a textual stub, queue holds the bytes, wrapper splices a `user` message with the image parts before the next `generateText` step. The `assistant` bridge between the tool result and the user message is required by Mistral-style chat templates that reject `user → tool → user` transitions; harmless on other providers. Validated across Anthropic / OpenAI / Gemini / Qwen / Mistral / Llama 3.2 Vision pre-PR.

**The read-gate.** `edit_file` refuses to mutate a path the agent hasn't `read_file`-ed in this run. Successful edits invalidate the path — the agent must re-read before its next edit on the same file. This catches "editing from stale memory" errors before they corrupt a file. It lives on `AgentContext.readPaths` in `runtime.ts`. `fetch` of a local text file also registers in this gate so an agent that views-then-edits doesn't need to re-read.

`create_file` and `delete_wiki` are terminal and don't interact with the gate.

The read-gate is orthogonal to `edit-context.ts`, which exists for **attribution**: when `applyEdit` runs, it pushes the agent's role onto a process-global registry; `syncFile` reads it back so `entity_edits.by_role` carries the right value. Filesystem-driven syncs (a human editing a wiki in their editor) leave the registry empty and attribute to `'human'`.

## Schema

Six tables in SQLite, fresh `001-foundation.sql`:

- `spaces (name PK, watch_dir UNIQUE, created_at)`
- `entities (space_name, source_path)` composite PK, `type` CHECK (`'wiki'|'file'`), `kind` CHECK (`'text'|'asset'`) — text drives the agent queues, asset is link-resolution-only — `label`, `source_hash` (SHA-256 of content for both kinds), `stat_fingerprint` (mtime+size cache for skipping unchanged reads), `properties` JSON (file-derived), `tags` JSON (agent-applied), timestamps
- `relationships (space_name, source_path, target_path)` composite PK, `link_text` — no FK on `target_path` (red links!)
- `entity_edits (space_name, entity_path, at)` composite PK — `at` carries millisecond precision via `strftime('%f')` so same-second writes don't collide. Not FK'd; history survives entity deletion.
- `conversations (id PK ULID, space_name, article_path NULLABLE, title)` — the **one** v0 table with an explicit ID, because conversations have no on-disk file to derive identity from. Phase 1 lays the schema; Phase 3 wires the routes.
- `conversation_messages (conversation_id, seq)` composite PK, `role`, `content` JSON

No auth, no actors, no versioning.

### Properties vs tags

The `entities` table carries two JSON bags, divided by origin:

- `properties` — **file-derived**. Wikis fill it from `<meta name="X" content="Y">` tags; sources get an auto-generated `file_type`. `syncFile()` rebuilds this column on every reconcile, so its contents always reflect what's on disk.
- `tags` — **agent-applied bookkeeping**. Written exclusively via the `tag_entity` tool (or `setEntityTag`/`deleteEntityTag` helpers). The sync UPDATE clauses are explicit-column and never touch `tags`, so it survives content edits — cleared only when the entity row itself is deleted (file removed) or the DB is wiped.

Tags exist so multi-agent pipelines can track "has role X processed entity Y" without conflating it with `inbound_max=0`-style structural queries. Convention: dotted-namespace keys (`editor.processed_hash`, `proposer.processed_hash`) — values are strings (encode timestamps, hashes, or status flags as needed). Liberal at this stage: any agent can write any key. `list_entities` exposes `has_tag` / `not_has_tag` / `tag_equals` filters that hit these via `json_each`, which handles dotted keys verbatim (a `json_extract('$.editor.processed')` path would otherwise be misread as a nested lookup).

## Key modules

- `src/server/lib/sync.ts` — `syncFile()`: read a file, parse HTML wiki or opaque source, upsert entity, extract `<a href>` edges. Single-pass — relationships rows have no FK on `target_path` so out-of-order syncs resolve at query time.
- `src/server/lib/html-meta.ts` — `parseHtmlMeta(html)` → `{title, properties}`.
- `src/server/lib/html-links.ts` — `extractHtmlLinks(html, fromPath)` + `resolveHref(href, fromPath)`. Drops external URLs, server-absolute paths, fragments, escaping `..`.
- `src/server/lib/fs-watcher.ts` — `node:fs.watch` recursive + 500ms debounce, calls `syncFile()` on changes, `removeByPath()` on deletes. Also bootstraps the per-space agent scheduler.
- `src/server/lib/file-edits.ts` — `applyEdit(space, edit, opts)`: the mutation chokepoint. Four kinds: `create`, `insert_at_line`, `str_replace`, `delete`. Exports `validateWikiHtmlDocument` for `create_file` (structural validation: `<!DOCTYPE>`/`<html>` + non-empty `<title>` + `<body>`).
- `src/server/lib/entities.ts` — `listEntities()` + `listRedLinks()` + `getEntity()`. Pure SQL, parameterized.
- `src/server/lib/search.ts` — ripgrep adapter (`@vscode/ripgrep`), spawns per-space, parses `--json` events, joins back to entities by path.
- `src/server/lib/reader.ts` — Phase 2 rendering primitives: `classifyAnchor`, `instrumentArticle`, `renderSpaceIndex`, `renderArticleIndex`. Pure functions; the route handlers in `routes/reader.ts` are thin glue.
- `src/server/lib/inbox.ts` — `slugify`, `utcDateStamp`, `resolveInboxPath` (with collision auto-suffix), `buildInboxContent`. Pure helpers for the `POST /:space/inbox` route.
- `src/server/lib/source-write-guards.ts` — `assertSourcePath` / `assertTextContent` / `sanitizeCaller`. Shared validation for both write-back endpoints. The HTTP write APIs are text-only — `assertTextContent` rejects SKIP_EXTENSIONS (secrets), ASSET_EXTENSIONS (binaries: drop them on disk instead, the watcher indexes them as kind='asset'), and content that sniffs binary. Reuses `sniffBufferIsText` from fs-watcher so the eligibility bar is the same one the watcher applies.
- `src/server/routes/inbox.ts` — `POST /:space/inbox` + `PUT /:space/sources/*`. Both go through `applyEdit` so the sync is synchronous and the response carries the synced entity. New sources have no `*.processed_hash` tag, so the editor cron picks them up on the next tick.
- `src/server/routes/reader.ts` — the four human-facing routes (`/`, `/:space`, `/:space/`, `/:space/wiki/*`, `/:space/*`). Mounted last so `/:space/*` is a true fallback.
- `src/server/agents/` — declarative `.arkeon/agents.yaml` config (Zod-validated), bundled role templates (`templates/*.yaml`), role-builder, tool registry, `runAgent` loop (Vercel AI SDK), per-space cron scheduler.
- `src/server/agents/cron.ts` — `nextTick(expr, from)` via `cron-parser`. Drives the scheduler's `setTimeout` chain.
- `src/server/agents/scheduler.ts` — per-space cron. Cron ticks queue per-space (FIFO) behind any in-flight or queued run via `queueSpaceMutex`. The HTTP run route stays fail-fast via `withSpaceMutex`. No orphan reclaim.
- `src/server/agents/space-scope.ts` — `resolveAllowedSpaces(scope, ownSpace)` + `resolveSpaceArg(arg, allowed)`. Multi-space reads, writes always to `ctx.space`.
- `src/server/extractors/` — binary file → HTML sidecar pipeline. `types.ts` declares `FileHandler` (name, extensions, declarative `dependencies`, async `extract` fn). `index.ts` is the registry: drop a new handler into `HANDLERS`, and the watcher, install-deps, and llms.txt auto-pick it up. `pdf.ts` is the only handler in v0 — spawns the bundled `python/pdf_extract.py` via the managed venv, emits HTML with text + `<img>` references to extracted figures + per-page renders into a `<binary>.assets/` sibling directory. `runner.ts` orchestrates: stage assets in a `.arkeon-ingest.*` dir, validate handler output, atomic rename, write sidecar, `setEditContext({role:"ingest"})` so `entity_edits` records the attribution, then `setEntityTag(extracted_by=<handler>)` so re-extraction can detect manual sidecars (`extracted_by=manual`) and skip them. `subprocess.ts` is the shared spawn helper — timeout, AbortSignal, global concurrency semaphore (default 4 via `ARKEON_WIKI_INGEST_CONCURRENCY`). The fs-watcher dispatches in parallel with `syncAsset` after a kind='asset' file with a registered extension lands; the sidecar's subsequent watcher event indexes it as a normal kind='text' source that flows into the editor's queue.

## API endpoints

Routes are space-scoped under `/{space}/...`. No auth required.

JSON API:

- `POST /spaces` — register a directory. Body `{name, watch_dir}`. Name collisions return 409.
- `GET /spaces` — list spaces with entity counts.
- `GET /spaces/:name` — single space.
- `GET /{space}/entities?type=&label_contains=&path_contains=&inbound_min=&inbound_max=&outbound_min=&outbound_max=&updated_since=&edited_by_role=&sort=&limit=&offset=&include=` — listEntities scoped to one space.
- `GET /{space}/entities/*` — single entity by path (path is whatever follows `/entities/`). `?include=content` reads the file body from disk.
- `GET /{space}/redlinks?limit=&offset=` — red-link queue, ranked by `demand`. Each row carries `target_path`, `demand`, `linked_from` (last 3 source paths).
- `GET /{space}/recent?since=&role=&limit=&offset=` — `entity_edits` feed.
- `GET /{space}/search?q=&type=&limit=&snippets=&regex=` — keyword search via ripgrep. `q` repeatable up to 10 times to OR patterns.
- `POST /{space}/inbox` — write-back for new sources. Body `{text, title?, kind?: "md"|"txt", tags?}`. Server writes to `sources/inbox/<YYYY-MM-DD>/<slug>.<ext>` (UTC date; slug from title, ULID fallback). Always creates (auto-suffixes on slug collision). With `kind: "md"` and a `title`, prepends `# <title>`. Returns `{space, path, entity}` with the synced entity inline. Optional `X-Caller` header sets `entity_edits.by_role` (allowlist `[A-Za-z0-9._-]{1,40}`, fallback `"api"`).
- `PUT /{space}/sources/*` — write-back at a caller-chosen path. URL tail is the disk path (always rooted in `sources/`); raw body is the content. 409 on existing path unless `?overwrite=true` (which destroys + recreates, emitting two `entity_edits` rows). Same `X-Caller` contract as `/inbox`. Wiki paths and binary content (NUL byte in first 8 KB AND extension not on the text allowlist) are rejected with 400. 10 MB body cap. The standard convention is `POST /inbox`; PUT is for callers that need a stable path (re-uploads, programmatic imports with their own naming scheme).
- `POST /{space}/chat`, `GET /{space}/chat/:conversation_id`, `DELETE ...` — **501 Phase 1 stubs**, wired up in Phase 3.
- `GET /health` / `GET /ready` — liveness/readiness.
- `GET /llms.txt` / `GET /help` — hand-written orientation guide for human and LLM callers (data model, flows, every route). Source: `src/server/lib/llms-txt.ts`. **When you add or change an endpoint that's useful for accessing the wiki, update `llms-txt.ts` so callers see the new surface.** A drift-guard unit test (`test/unit/llms-txt.test.ts`) asserts every known route string is present; adding a route without touching the guide will fail CI once you add it to the test, but the test can't detect endpoints you forgot to register at all — treat the guide as a required deliverable for any new route, not an optional polish step.

Human-facing reader (Phase 2):

- `GET /` — HTML spaces list (alphabetical, with per-space entity counts).
- `GET /{space}` — 301 redirect to `/{space}/` (keeps relative hrefs correct on the index page).
- `GET /{space}/` — HTML article index (`type='wiki'` only, alphabetical by `label`, with `short_description` subtitles).
- `GET /{space}/wiki/*` — wiki article with chrome injection (`<div id="arkeon-chrome">`) and link classes (`arkeon-wiki`, `arkeon-file`, `arkeon-redlink`). The reader parses the on-disk HTML, decorates anchors, and serializes — never rewrites hrefs, so the same file opens identically via `file://`.
- `GET /{space}/*` — static-file fallback. Serves any non-wiki path inside the watch dir with the right `Content-Type` (markdown → `text/markdown`, PDF → `application/pdf`, images → `image/*`, etc.). Path-traversal escapes return 404.

Content lives on disk — the API returns metadata, relationships, and (optionally) file bodies.

The reader is the "everything else" layer — it's mounted last so its `/:space/*` fallback only matches URLs no other route has claimed. The hard rule: URL structure mirrors disk structure within a space (`wiki/foo.html` on disk → `/{space}/wiki/foo.html` over HTTP). Articles render identically under `file://` and `http://`.

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
arkeon-wiki install                  # persistent service: starts at login, restarts on crash
arkeon-wiki uninstall                # remove the service
arkeon-wiki install-deps             # bootstrap the binary-ingestion toolchain (Python venv + system bins)
arkeon-wiki install-deps --check     # verify-only — exit non-zero on missing dep
```

Run multiple instances side by side with `--name`:

```bash
arkeon-wiki up --name dev-a          # state at ~/.arkeon-wiki/dev-a/, port derived from name
arkeon-wiki up --name dev-b          # independent daemon, different port
```

The port for a named instance is `8000 + sha256(name) mod 999 + 1`.

## Persistent service (macOS launchd / Linux systemd)

`arkeon-wiki up` spawns a detached child that survives shell exit but not reboot. `arkeon-wiki install` registers the daemon with the platform's service supervisor so it starts at login and restarts on crash.

- **macOS:** writes `~/Library/LaunchAgents/tech.arkeon.wiki[.<name>].plist` and bootstraps it into the user's launchd domain (`gui/$UID`). No sudo. `KeepAlive: { SuccessfulExit: false, Crashed: true }` means a clean `arkeon-wiki down` stays down, but a crashed daemon comes back within `ThrottleInterval` (10s).
- **Linux:** writes `~/.config/systemd/user/arkeon-wiki[-<name>].service` and enables it via `systemctl --user enable --now`, then `try-restart` so a re-install with changed paths actually picks up the new unit (enable --now is a no-op for an already-active service). Also runs `loginctl enable-linger $USER` (best-effort — polkit may refuse for non-root callers; failures surface as a warning + `linger_enabled: false` in the install JSON, but the service still works for users with a graphical session). No sudo. `Restart=on-failure` + `RestartSec=10` parallel the launchd contract: clean down stays down, crash → restart after 10s. On non-systemd Linux (Alpine, WSL1, OpenRC distros) the install refuses with actionable manual instructions instead of writing a unit that can't load. **Requires systemd 240+** (Debian 11+, Ubuntu 20.04+, RHEL 8+) for the `StandardOutput=append:` syntax — older systemd versions reject the unit.

`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are not stored in the plist (plists are world-readable on multi-user Macs). Install captures them into `~/.arkeon-wiki/.env`, where the existing env-loader (`server/agents/env-loader.ts:42`) reads them at startup. Idempotent: never overwrites an existing value.

When a service is installed, `up` / `down` / `status` automatically coordinate with the supervisor instead of fighting it:

- `up` detects an installed service and delegates to the supervisor (`launchctl kickstart -k` on macOS, `systemctl --user start` on Linux) instead of spawning a detached child (which would create an orphan the supervisor doesn't track). Reports `managed_by: "service"` in the result.
- `down` uses `SIGTERM`, the daemon exits cleanly (exit code 0), and the supervisor respects `SuccessfulExit: false` (launchd) / `Restart=on-failure` (systemd) — does not auto-restart. The daemon stays down until next `up` or login.
- `status` reports a `service` field (`installed`, `running`, `pid`, `unit_path`) so consumers see service state independently of pidfile state.

Manual e2e: `packages/arkeon/scripts/test-service.sh` runs the full install → kill -9 → down → up → uninstall lifecycle with `--name service-smoke-test`, asserting state at each step. Platform-aware — works on both macOS and Linux. ~30s.

For Mac developers who want to validate the Linux path before shipping (no Linux box handy), `packages/arkeon/test/systemd-integration/run.sh` spins up real systemd inside a Docker container (jrei/systemd-debian, qemu-emulated linux/amd64 on Apple Silicon) and runs the same 8-step lifecycle inside. ~60s. Requires Docker daemon running.

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
- `~/.arkeon-wiki/<home>/arkeon.log` — daemon stdout/stderr. Size-capped via in-process rotation when `ARKEON_WIKI_LOG_ROTATE=1` is set: each file is held under 50 MB and 3 backups are retained (`arkeon.log.1` ... `.3`), bounding total disk usage to ~200 MB per instance. The `up` spawner, launchd plist, and systemd unit all set the env var so headless daemons get rotation by default; foreground `arkeon-wiki start` runs without it. Override the size knobs via `ARKEON_WIKI_LOG_MAX_BYTES` / `ARKEON_WIKI_LOG_MAX_FILES`.
- `~/.arkeon-wiki/instances/<name>.json` — registry of running instances
- `~/.arkeon-wiki/.env` — user-global env file. `install` writes API keys here; the agent runtime reads them at startup. Never overwritten — values rotate by editing the file.
- `~/.arkeon-wiki/python/` — managed Python venv bootstrapped by `install-deps`. Houses the runtime for handler extractors (currently PyMuPDF for PDFs). Re-running `install-deps` is idempotent and upgrades packages in place.
- `~/.arkeon-wiki/adapters.json` — versioned manifest written by `install-deps` recording resolved paths to the venv's Python + system binaries + installed package versions. Read at extraction time; throw `AdaptersManifestMissingError` if missing (run `install-deps`).
- `~/Library/LaunchAgents/tech.arkeon.wiki[.<name>].plist` — service plist when `install` has been run on macOS. Owned by the user; survives reboot.
- `~/.config/systemd/user/arkeon-wiki[-<name>].service` — service unit when `install` has been run on Linux. Symlinked from `default.target.wants/` after `enable`; survives reboot with `loginctl enable-linger`.
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

## Binary ingestion

Binary files like PDFs are indexed as `kind='asset'` (linkable from any wiki, never queued) and then run through an **extractor pipeline** that writes an HTML **sidecar** the editor can read on the queue.

Lifecycle of `paper.pdf` landing in `sources/`:

1. Watcher sees the file → `syncFile` creates a `kind='asset'` entity row.
2. Watcher dispatches to `runExtraction` if the extension is in `INGESTABLE_EXTENSIONS` (PDF in v0).
3. Runner spawns the bundled `pdf_extract.py` script via the managed Python venv. Script writes:
   - `paper.pdf.html` (sidecar — text-as-HTML, `<img>` references to extracted figures + per-page renders)
   - `paper.pdf.assets/page-N.png` (whole-page renders at 150 DPI — always emitted, defensive)
   - `paper.pdf.assets/page-N-fig-M.{png|jpg}` (embedded figures)
4. Watcher fires again for the sidecar → it indexes as `kind='text'`, enters the editor's queue.
5. Sidecar's `<img>` references resolve to indexed asset entities (PR #167 walks `<img src>` as relationships). The agent reads images via the `fetch` tool (PR #169).

**Adding a new handler:** drop a new module under `src/server/extractors/<format>.ts` exporting a `FileHandler` (extensions, declarative `dependencies`, async `extract`), register it in `index.ts`'s `HANDLERS` array, and add a fixture. The watcher dispatch, install-deps planning, and llms-txt all derive their behavior from the registry — no edits needed elsewhere.

**Install-deps required.** Run `arkeon-wiki install-deps` once per machine to bootstrap `~/.arkeon-wiki/python/` (uses `uv` if present, falls back to `python3 -m venv`). The daemon starts fine without it; PDFs just get skipped with a log line until install-deps completes.

**Re-extraction skip rules.** The sidecar's `extracted_by` tag protects user work:
- `extracted_by` is missing (sidecar pre-existed our extractor or was hand-written) → skip.
- `extracted_by="manual"` (user took it over) → skip.
- `extracted_by="pymupdf"` or other known handler → re-extract on binary content change.

Force a re-extraction by deleting the sidecar; the next watcher tick will rebuild it.

**Concurrency.** `runSubprocess` enforces a global cap (default 4, override via `ARKEON_WIKI_INGEST_CONCURRENCY`). A fresh corpus dump of 100 PDFs won't fan out 100 subprocesses.

**Failure mode.** If extraction throws (subprocess crash, timeout, validation failure), the runner writes a **stub sidecar** with the error inline. Editor still sees the source exists; failure is visible at the next read.

## Schema migrations

`src/schema/001-foundation.sql` is the v0 reset point — six tables. Subsequent files (`002-entity-tags.sql`, ...) are additive migrations applied in lexicographic order and recorded in `schema_migrations` (`src/schema/migrate.ts`), so they run exactly once.

Use `ALTER TABLE ... ADD COLUMN` with `NOT NULL DEFAULT` for new columns — SQLite rewrites the table-defining schema entry rather than the row data, so even large tables migrate in milliseconds. The DB is a pure index of filesystem state (the only column that doesn't have an on-disk counterpart is `entity_edits` history), so a `rm ~/.arkeon-wiki/data/arke.db && arkeon-wiki up` reset is always available as a fallback for development.

`json_patch` / `json_object` / `json_each` (used by the tag helpers and filters) require SQLite 3.38+. better-sqlite3 bundles SQLite, so this is satisfied at the application level; portability to a system sqlite3 isn't a goal.

## What's NOT here (yet)

- Chat-with-article → **Phase 3** (`tasks/v0-chat.md`). Schema is in place; routes are stubs.
- Human-facing UI for `/{space}/search`, `/{space}/recent`, `/{space}/redlinks`, per-article history. APIs exist; the reader pages don't render them in v0 (see `tasks/v0-reading-experience.md` for what was deliberately cut).
- Cross-space link resolution — schema is ready (`relationships.target_path` is unconstrained text; URL scheme `/{other-space}/wiki/...` is committed). Writer prompt updates wait for **v0.5**.
- Vector / semantic search — returns at **v0.5** when corpus crosses ~2,000 articles.
- FTS5 / BM25 ranking (ripgrep gives substring matching only)
- No auto rename refactor — deleting a wiki leaves its inbound edges as red links by design. A real rename is an explicit file-editing operation that walks every article with `<a href="old">` and rewrites the href; v0 doesn't ship that tool yet
