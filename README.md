# arkeon-wiki

A filesystem-first substrate for agent harnesses. Point the daemon at one directory; it watches files, indexes them into SQLite, and exposes a small JSON API. External harnesses (Hermes, OpenClaw, Claude Code, anything else) own the agent loop. Arkeon is just the substrate.

## Quick start

```bash
npm install -g arkeon-wiki
arkeon-wiki up --watch-dir ~/work/corpus
```

The daemon detaches, watches `~/work/corpus` recursively, and serves the API on `http://localhost:8000`. Drop files into the directory — they get indexed. Stop with `arkeon-wiki down`.

For a daemon that survives reboot and restarts on crash, run `arkeon-wiki install` (macOS launchd or Linux systemd `--user`).

## What gets indexed

Every file the watcher sees lands in the `artifacts` table keyed by its path relative to the watched root (e.g. `iarpa/sources/paper.pdf`).

- HTML files: `<title>` + `<meta>` tags go into `properties`; `<a class="wikilink">` anchors become graph edges with optional `data-*` citation metadata captured in `links.attrs` JSON.
- Markdown: `[[X]]` and `[[X|Display]]` wikilinks resolve by shortest-unique-basename match against the index.
- Text files (code, configs, logs, ...): indexed for FTS5 search; no link extraction.
- Binaries (PDFs today): indexed as `kind='asset'` so links resolve. An HTML sidecar lands at `.sidecars/<mirrored-path>.html` (run `arkeon-wiki install-deps` once to bootstrap the PyMuPDF venv).

The filesystem is the source of truth. SQLite is the index. Delete a file → its row goes. Edit a file → re-sync. No manual commands.

## HTTP API — six commands

Default base URL: `http://localhost:8000`. No auth (loopback bind). All POSTs are JSON.

```
POST /query        { folder?, kinds?, has_tag?[], not_tag?[], text?, limit?, offset? }
POST /tag          { path, key, value? }
POST /untag        { path, key }
GET  /tags?path=...
GET  /backlinks?path=...
GET  /redlinks?folder=...&limit=&offset=
```

Tag conventions: `key:value` strings throughout (e.g. `status:feedback`, `processed-by:editor`). Workers query for artifacts MISSING their `processed-by:<worker-name>` tag. "No tag = unprocessed."

`POST /query` filters are AND-composed. `has_tag` / `not_tag` entries can be `"key"` (presence) or `"key:value"` (key+value match). `text` runs FTS5 MATCH against the artifact body.

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
arkeon-wiki start                     # foreground (for pm2/launchd/etc.)
arkeon-wiki install                   # persistent service
arkeon-wiki uninstall                 # remove the service
arkeon-wiki install-deps              # bootstrap Python venv for PDF extraction
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

1. `POST /query` with `not_tag: ["processed-by:<worker-name>"]` and whatever folder/has_tag filters fit the worker.
2. Read each artifact from the filesystem.
3. Write outputs to the filesystem (the watcher indexes them).
4. `POST /tag` with `processed-by:<worker-name>` to mark the artifact done.

New content surfaces because `syncFile` indexes new artifacts without any `processed-by` tag — the worker's next tick picks them up automatically.

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
