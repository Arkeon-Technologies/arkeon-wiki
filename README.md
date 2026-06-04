# arkeon-wiki

A filesystem-first substrate for agent harnesses. Point the daemon at one directory; it watches files, indexes them into SQLite, and exposes a small JSON API. External harnesses (Hermes, OpenClaw, Claude Code, anything else) own the agent loop. Arkeon is just the substrate.

## Quick start

Two distribution surfaces. Pick one.

### Docker (recommended — binary extractors included)

```bash
curl -O https://raw.githubusercontent.com/Arkeon-Technologies/arkeon-wiki/main/docker-compose.example.yml
cp docker-compose.example.yml docker-compose.yml
# edit volumes:/watch to point at your corpus
# Linux: set PUID/PGID to your host `id -u` / `id -g`
# Docker Desktop (Mac/Windows): leave the defaults — bind-mount writes
# end up owned by your host user regardless.
docker compose up -d
# Wait for readiness (SQLite probe). 200 = ready, 503 = still warming.
curl -s http://localhost:8062/ready
open http://localhost:8062
```

The image bakes PyMuPDF (PDF extraction) so it works out of the box — no host-side bootstrap. Multi-arch (`linux/amd64` + `linux/arm64`). Image: `ghcr.io/arkeon-technologies/arkeon-wiki:latest`.

**Corpus directory ownership.** On Linux, the daemon writes sidecars and `.arkeon-wiki-state/` next to your files; if the corpus dir was auto-created by Docker (root-owned), `PUID`/`PGID` writes will fail. Either `chown -R $(id -u):$(id -g) ./corpus` before `up -d`, or `mkdir -p ./corpus` ahead of time so it inherits your shell's user.

Verify PDF extraction with any PDF you already have — or print this README to one (macOS Preview ⌘P → "Save as PDF"; Linux: any browser's Print → PDF). Drop it under `./corpus/`, then `curl http://localhost:8062/stats` should show the asset count tick up and a sidecar appear under `./corpus/.sidecars/`.

**Teardown.** `docker compose down -v` removes the container + the named state volume (SQLite index, daemon logs). The `.sidecars/` tree inside your bind-mounted corpus stays on disk — that's the filesystem-is-truth contract. To wipe sidecars too, `rm -rf ./corpus/.sidecars/` after `down -v`; the watcher will rebuild them next time you `up -d` against the same corpus.

### npm (HTML + Markdown only)

```bash
npm install -g arkeon-wiki
arkeon-wiki up --watch-dir ~/work/corpus
```

The daemon detaches, watches `~/work/corpus` recursively, and serves the API on `http://localhost:8000`. Drop files into the directory — they get indexed. Stop with `arkeon-wiki down`. For a daemon that survives reboot, run `arkeon-wiki install` (macOS launchd or Linux systemd `--user`).

PDF extraction is **not** available on the npm path — use the Docker image if you need binary handlers.

## What gets indexed

Every file the watcher sees lands in the `artifacts` table keyed by its path relative to the watched root (e.g. `iarpa/sources/paper.pdf`).

- HTML files: `<title>` populates the artifact's top-level `label`; every `<meta name="X" content="Y">` lands in `properties[X]`. Two meta names are reserved and skipped (they'd shadow top-level columns): `title` and `label`. `<a class="wikilink">` anchors become graph edges with optional `data-*` citation metadata captured in `links.attrs` JSON.
- Markdown: `[[X]]` and `[[X|Display]]` wikilinks resolve by shortest-unique-basename match against the index.
- Text files (code, configs, logs, ...): indexed for FTS5 search; no link extraction.
- Binaries (PDFs today): indexed as `kind='asset'` so links resolve. An HTML sidecar lands at `.sidecars/<mirrored-path>.html` (requires the Docker image — PyMuPDF ships baked in). The sidecar's `label` is derived from the binary's filename basename (not the embedded `<title>`) so asset and sidecar labels stay aligned for harnesses dereferencing `asset.properties.sidecar_path`.

The filesystem is the source of truth. SQLite is the index. Delete a file → its row goes. Edit a file → re-sync. No manual commands.

### A minimal HTML article

Drop this under your watched root as `iarpa/example.html` and it'll be a fully-indexed article with title, meta, wikilinks, and citation metadata:

```html
<!doctype html>
<html>
<head>
  <title>Why semiconductor exports matter</title>
  <meta name="status" content="draft">
  <meta name="topic" content="us-china">
</head>
<body>
  <p>
    The 2024 controls cited
    <a class="wikilink"
       href="./sources/bis-2024.pdf"
       data-quote="On October 7th, the Department imposed..."
       data-page="3"
       data-cite-type="evidence">the BIS rule</a>
    as the immediate trigger.
  </p>
</body>
</html>
```

`title` becomes the artifact's `label`; `status` and `topic` land in `properties`; the wikilink lands in `links` with `attrs: { quote, page, "cite-type" }` (the `data-` prefix is stripped). Use `[[X]]` syntax in `.md` files for the same effect with shortest-unique-basename resolution.

## HTTP API

Default base URL: `http://localhost:8062` for Docker, `http://localhost:8000` for npm. No auth (loopback bind). All POSTs are JSON.

```
POST /query     { folder?, kinds?, has_tag?[], not_tag?[], text?, limit?, offset? }
                → { artifacts: [{ path, kind, label, source_hash, properties, tags, created_at, updated_at }], total }
POST /tag       { path, key, value? }
                → { ok, path, key, value, previous_value, action }   # action ∈ created|updated|unchanged
POST /untag     { path, key }
                → { ok, path, key, existed }
POST /reconcile {}
                → { ok, created, updated, unchanged, removed, failed, took_ms, coalesced }
GET  /tags?path=...
                → { path, tags: { key: value, ... } }
GET  /backlinks?path=...
                → { path, exists, demand, backlinks: [{ source_path, link_text, attrs, synced_at }] }
GET  /redlinks?folder=...&limit=&offset=
                → { redlinks: [{ target_path, demand, linked_from: [...] }], total }
GET  /stats     → { artifacts: { total, text, asset }, links, redlinks, tag_keys }
GET  /health    — liveness
GET  /ready     — readiness (probes SQLite)
GET  /llms.txt  — full API reference (also at /help)
```

Two tag-key conventions coexist:

- **Worker gates** — one key per worker, e.g. `processed-by-editor`, `processed-by-writer`. Each worker queries for artifacts MISSING its own key. **Do not** collapse these into a single `processed-by` key with the worker name as value — worker A's tag would clobber worker B's.
- **Content labels** — `key:value` strings like `status:feedback`, `topic:us-china`, where the value carries meaning across artifacts.

"No tag = unprocessed" is the trigger model.

`POST /query` filters are AND-composed. `has_tag` / `not_tag` entries can be `"key"` (presence) or `"key:value"` (key+value match). `text` runs FTS5 MATCH against the artifact body.

**Strict body validation.** POST endpoints reject malformed JSON with `400 invalid_json` and unknown top-level fields with `400 unknown_field`. A typo like `notag` instead of `not_tag` errors loudly rather than silently returning the unfiltered corpus.

**Reserved characters.** Tag KEYS may not contain `:` (`400 reserved_character`). The colon is the key/value separator in `has_tag` / `not_tag` query specs — a literal colon in the key would store fine but then collide on read with the (key, value) split. Pass the colon in the request shape (`{ key: "status", value: "published" }`), not in the key. Values may contain colons.

**Watcher is best-effort; reconcile is the source of correctness.** `node:fs.watch` silently drops events under bulk filesystem load — FSEvents on macOS, inotify on Linux, the Docker-Desktop bind-mount FUSE layer. A `mv *.html corpus/` over a few thousand files can leak unlink events, leaving stale rows at the old paths. The daemon runs a periodic reconcile sweep (default every 30s) that re-walks the root, prunes orphan rows, and dispatches sidecar extraction for any ingestable binary whose `.sidecars/` HTML is missing — so a bulk drop of PDFs heals end-to-end, not just the index half. Tune via `ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS` (set `0` to disable). For an immediate heal, `POST /reconcile` (or `arkeon-wiki reconcile`). Response includes a `failed` counter so a harness can distinguish a clean sweep from N silently-failed syncs. Concurrent calls coalesce — single-flight lock — so a manual call colliding with a periodic sweep doesn't double the work.

`GET /redlinks` aggregates the queue the same way the resolver itself resolves links — so a row represents one concrete unit of work:

- Each unique fs-path target is its own row. `iarpa/wiki.html` and `chartbook/wiki.html` are two distinct gaps; creating one resolves only the anchors that named exactly that path.
- An MD slug redlink (`[[wiki]]`, no folder/extension) merges into a fs-path row only when its basename has exactly one fs-path match in the queue — the same condition under which `[[wiki]]` would auto-resolve once the file lands. With zero matches the slug stays as its own row (target=`wiki`). With two+ matches the slug stays standalone too (ambiguous — same way the resolver punts).

Branch on `target_path.includes("/")` to distinguish "create at this path" from "create anywhere by basename." Cross-folder same-basename collisions stay visible as separate work items rather than masquerading as one.

Full reference at `GET /llms.txt` or `GET /help`.

## Reader

URL structure mirrors disk structure.

- `GET /` — directory listing of the watched root.
- `GET /<path>/` — directory listing of any subfolder.
- `GET /<path>` — serve the file. HTML files run through wikilink rewriting; unresolved `<a class="wikilink">` anchors gain a `redlink` class so CSS can style them.

The same article opens identically under `file://` and `http://`.

## CLI

### Daemon lifecycle

```bash
arkeon-wiki up [--watch-dir <path>]   # start the daemon detached
arkeon-wiki down                      # stop it
arkeon-wiki status                    # is it running?
arkeon-wiki ls                        # list running instances
arkeon-wiki where                     # which daemon will my next command hit?
arkeon-wiki logs [-f]                 # print/tail the daemon log
arkeon-wiki start                     # foreground (for pm2/launchd/Docker/etc.)
arkeon-wiki install                   # persistent service
arkeon-wiki uninstall                 # remove the service
```

`--name <name>` runs multiple instances side by side (different state dirs, different ports).

### Substrate API (one CLI command per HTTP endpoint)

Thin wrappers over the HTTP API — no SQLite reads, no caching. Pretty-print on a TTY, raw JSON when piped (so `arkeon-wiki query | jq` works).

```bash
arkeon-wiki query [--folder X --kinds text --has-tag K[:V] --not-tag K --text Q ...]
arkeon-wiki tag <path> <key>[=<value>]   # UPSERT — = and value optional
arkeon-wiki untag <path> <key>
arkeon-wiki tags <path>                  # list every tag on an artifact
arkeon-wiki backlinks <path>             # inbound link rows (works for redlinks too)
arkeon-wiki redlinks [--folder X --limit N --offset N]
arkeon-wiki stats                        # corpus-level counts
arkeon-wiki reconcile                    # force a full re-walk + orphan-prune now
```

Reading article bodies is *not* a CLI command — the filesystem is the read API. `cat`, `bat`, `$EDITOR` work fine; the daemon's job is the index, not the read path.

**Daemon resolution.** Every substrate-API command picks a daemon in this order: `--api-url <url>` → `ARKEON_WIKI_URL` env → `--name <inst>` → CWD walk (deepest registered `watch_dir` containing your shell's cwd) → `default` instance → in-container fallback (`http://127.0.0.1:${PORT}` when `ARKEON_WIKI_IN_CONTAINER=1`, which the Dockerfile sets so `docker exec arkeon-wiki arkeon-wiki query` Just Works). Run `arkeon-wiki where` to see exactly which source resolved and which `api_url` is on the other end. Exit codes: `0` success, `1` HTTP 4xx/5xx (response body on stderr), `2` network error.

**`--api-url` placement.** `--api-url` is per-command, not program-level: write `arkeon-wiki query --api-url http://...` (the flag AFTER the subcommand). The program-level `--data-dir` flag still comes before the subcommand.

**Auth flag is forward-looking.** `--token <token>` and `ARKEON_WIKI_TOKEN` are wired into every substrate-API command so future hardening doesn't break invocations — the daemon currently ignores them and `Authorization: Bearer …` headers are silently dropped. Treat `--token` as scaffolding, not enforcement.

## Persistent service

`arkeon-wiki up` runs detached — survives your shell, not reboot. For boot-time start + auto-restart on crash:

```bash
arkeon-wiki install                 # default instance
arkeon-wiki install --name dev-a    # named instance
arkeon-wiki uninstall               # remove the service (leaves data intact)
```

- **macOS**: writes `~/Library/LaunchAgents/tech.arkeon.wiki[.<name>].plist` and bootstraps into the user's launchd domain. No sudo.
- **Linux**: writes `~/.config/systemd/user/arkeon-wiki[-<name>].service`, enables via `systemctl --user enable --now`, runs `loginctl enable-linger` (best-effort) so the service survives logout. Requires systemd 240+. On non-systemd Linux (Alpine, OpenRC) the install refuses with manual instructions instead of producing a broken unit.

When a service is installed, `up` / `down` / `status` coordinate with the supervisor automatically.

## Configuration

All state lives in `~/.arkeon-wiki/`.

| Setting | Purpose |
|---|---|
| `--watch-dir <path>` / `ARKEON_WIKI_WATCH_DIR` | Directory the daemon indexes |
| `ARKEON_WIKI_HOME` / `--data-dir` | Override the state directory (default `~/.arkeon-wiki/`) |
| `--port <port>` | API port (default 8000, or derived from `--name`) |
| `--name <name>` | Run a named instance side-by-side with others |
| `ARKEON_WIKI_HOST` | Bind address (default `127.0.0.1` — loopback) |

## Trigger pattern (for harnesses)

External harnesses do the agent loop. Each worker tick:

1. `POST /query` with `not_tag: ["processed-by-<worker-name>"]` and whatever folder/has_tag filters fit the worker.
2. Read each artifact from the filesystem.
3. Write outputs to the filesystem (the watcher indexes them).
4. `POST /tag` with `{ key: "processed-by-<worker-name>", value: <artifact.source_hash> }` to mark the artifact done.

New content surfaces because `syncFile` indexes new artifacts without any `processed-by-*` tag — the worker's next tick picks them up automatically.

**Detecting edits — use `source_hash` as the tag value.** "No tag = unprocessed" surfaces *new* files. To surface *edited* files, store the artifact's `source_hash` as the tag value, then widen the gate so anything with a stale hash is re-included:

```jsonc
// Anything missing the tag, OR tagged with a different hash than the
// artifact currently has, should be re-processed.
POST /query
{
  "kinds": ["text"],
  "not_tag": ["processed-by-editor"]
}
// → process the artifacts you get back, then for each:
POST /tag
{ "path": "...", "key": "processed-by-editor", "value": "<artifact.source_hash>" }
```

A second pass then catches *edited* artifacts (already-tagged but the hash drifted):

```jsonc
// Find anything where the recorded hash no longer matches the current
// source_hash. The simplest approach: list everything with the tag,
// then in the harness compare tag.value to artifact.source_hash.
POST /query
{ "kinds": ["text"], "has_tag": ["processed-by-editor"] }
```

If `tag.value !== artifact.source_hash`, the source changed since you last processed it — re-run and overwrite the tag (UPSERT). The `action: "updated"` response on `POST /tag` confirms a collision was overwritten.

**Tag the sidecar, not the binary.** Worker `processed-by-<name>` tags belong on the `kind='text'` sidecar (`.sidecars/<mirrored>.html`), not on the `kind='asset'` binary — asset rows are invisible to `kinds: ["text"]` queries. Use `asset.properties.sidecar_path` to find the right target.

## Development

```bash
git clone https://github.com/Arkeon-Technologies/arkeon-wiki
cd arkeon-wiki
npm install
npx tsx packages/arkeon/src/index.ts start --watch-dir /tmp/test-corpus
```

### Testing

```bash
npm run typecheck -w packages/arkeon
npm test -w packages/arkeon
npm run test:e2e -w packages/arkeon
```

## License

Apache License, Version 2.0. See [LICENSE](./LICENSE).
