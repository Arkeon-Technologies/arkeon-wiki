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
open http://localhost:8062
```

The image bakes PyMuPDF (PDF extraction) so it works out of the box — no host-side bootstrap. Multi-arch (`linux/amd64` + `linux/arm64`). Image: `ghcr.io/arkeon-technologies/arkeon-wiki:latest`.

Verify PDF extraction (any plain PDF works — generate one with `pandoc README.md -o test.pdf` if you don't have one handy, or use macOS Quick Look "Print → Save as PDF"). Drop it under `./corpus/`, then `curl http://localhost:8062/stats` should show the asset count tick up and a sidecar appear under `./corpus/.sidecars/`.

### npm (HTML + Markdown only)

```bash
npm install -g arkeon-wiki
arkeon-wiki up --watch-dir ~/work/corpus
```

The daemon detaches, watches `~/work/corpus` recursively, and serves the API on `http://localhost:8000`. Drop files into the directory — they get indexed. Stop with `arkeon-wiki down`. For a daemon that survives reboot, run `arkeon-wiki install` (macOS launchd or Linux systemd `--user`).

PDF extraction is **not** available on the npm path — use the Docker image if you need binary handlers.

## What gets indexed

Every file the watcher sees lands in the `artifacts` table keyed by its path relative to the watched root (e.g. `iarpa/sources/paper.pdf`).

- HTML files: `<title>` + `<meta>` tags go into `properties`; `<a class="wikilink">` anchors become graph edges with optional `data-*` citation metadata captured in `links.attrs` JSON.
- Markdown: `[[X]]` and `[[X|Display]]` wikilinks resolve by shortest-unique-basename match against the index.
- Text files (code, configs, logs, ...): indexed for FTS5 search; no link extraction.
- Binaries (PDFs today): indexed as `kind='asset'` so links resolve. An HTML sidecar lands at `.sidecars/<mirrored-path>.html` (requires the Docker image — PyMuPDF ships baked in).

The filesystem is the source of truth. SQLite is the index. Delete a file → its row goes. Edit a file → re-sync. No manual commands.

## HTTP API

Default base URL: `http://localhost:8062` for Docker, `http://localhost:8000` for npm. No auth (loopback bind). All POSTs are JSON.

```
POST /query        { folder?, kinds?, has_tag?[], not_tag?[], text?, limit?, offset? }
POST /tag          { path, key, value? }
POST /untag        { path, key }
GET  /tags?path=...
GET  /backlinks?path=...
GET  /redlinks?folder=...&limit=&offset=
GET  /stats
GET  /health       — liveness
GET  /ready        — readiness (probes SQLite)
GET  /llms.txt     — full API reference (also at /help)
```

Two tag-key conventions coexist:

- **Worker gates** — one key per worker, e.g. `processed-by-editor`, `processed-by-writer`. Each worker queries for artifacts MISSING its own key. **Do not** collapse these into a single `processed-by` key with the worker name as value — worker A's tag would clobber worker B's.
- **Content labels** — `key:value` strings like `status:feedback`, `topic:us-china`, where the value carries meaning across artifacts.

"No tag = unprocessed" is the trigger model.

`POST /query` filters are AND-composed. `has_tag` / `not_tag` entries can be `"key"` (presence) or `"key:value"` (key+value match). `text` runs FTS5 MATCH against the artifact body.

`GET /redlinks` returns two shapes of `target_path`: HTML `<a class="wikilink" href="...">` resolves to an fs-relative path at extraction time (e.g. `iarpa/sources/missing.html`), while Markdown `[[X]]` keeps the literal slug (e.g. `missing-topic`) until a matching artifact lands, then auto-converges. Branch on `target_path.includes("/")` if your harness needs to distinguish "create at this path" from "create anywhere by basename."

Full reference at `GET /llms.txt` or `GET /help`.

## Reader

URL structure mirrors disk structure.

- `GET /` — directory listing of the watched root.
- `GET /<path>/` — directory listing of any subfolder.
- `GET /<path>` — serve the file. HTML files run through wikilink rewriting; unresolved `<a class="wikilink">` anchors gain a `redlink` class so CSS can style them.

The same article opens identically under `file://` and `http://`.

## CLI

```bash
arkeon-wiki up [--watch-dir <path>]   # start the daemon detached
arkeon-wiki down                      # stop it
arkeon-wiki status                    # is it running?
arkeon-wiki ls                        # list running instances
arkeon-wiki logs [-f]                 # print/tail the daemon log
arkeon-wiki start                     # foreground (for pm2/launchd/Docker/etc.)
arkeon-wiki install                   # persistent service
arkeon-wiki uninstall                 # remove the service
```

`--name <name>` runs multiple instances side by side (different state dirs, different ports).

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
4. `POST /tag` with `{ key: "processed-by-<worker-name>", value: <hash-or-ts> }` to mark the artifact done.

New content surfaces because `syncFile` indexes new artifacts without any `processed-by-*` tag — the worker's next tick picks them up automatically.

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
