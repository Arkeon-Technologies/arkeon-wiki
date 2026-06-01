// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Static API guide served at `GET /llms.txt` and `GET /help`.
 * Hand-maintained — update when routes or conventions change.
 */

export const LLMS_TXT = `# arkeon-wiki

A filesystem-first substrate for agent harnesses. Point the daemon at
ONE directory; it watches files, indexes them into SQLite, and exposes
a small JSON API. The filesystem is the source of truth; SQLite is
the index.

The agent runtime is NOT here. External harnesses (Hermes, OpenClaw,
Claude Code, anything) own the loop. Arkeon is just the substrate.

## Data model

A single watched root contains everything. Top-level subdirectories
are conventionally used as "spaces" (e.g. \`iarpa/\`, \`chartbook/\`)
but the daemon doesn't enforce that — every file's path is its
identity, full stop.

Three tables in SQLite, plus an FTS5 virtual table:

  - **artifacts** \`(path PK, kind, label, source_hash, properties)\`
    Every file the watcher indexes. \`kind='text'\` for HTML/MD/text
    sources and binary sidecars (everything FTS-searchable);
    \`kind='asset'\` for binaries (linkable, not searchable).

  - **tags** \`(path, key, value)\` — agent-applied bookkeeping.
    Convention: \`key:value\` strings. Workers query for artifacts
    MISSING their \`processed-by:X\` tag. "No tag = unprocessed."

  - **links** \`(source_path, target_path, link_text, attrs)\` —
    every \`<a class="wikilink">\` (HTML) or \`[[X]]\` (Markdown) the
    extractor resolved. \`attrs\` is a JSON map of \`data-*\`
    attributes for citation metadata (data-quote, data-page,
    data-cite-type, …). Targets with no matching artifact are
    redlinks.

  - **fts_artifacts** — FTS5 over text-kind artifact contents.
    Populated by syncFile; queried via POST /query \`{text}\`.

## Link conventions

HTML: \`<a class="wikilink" href="./topic-x">topic X</a>\`. Only
anchors with \`wikilink\` in their class list become graph edges.
Other \`<a>\` elements render as ordinary HTML.

Markdown: \`[[X]]\` resolves by shortest-unique-basename match
against the artifact index. \`[[folder/X]]\` works for
disambiguation. \`[[X|Display]]\` carries an alias.

Citation metadata: \`<a class="wikilink" data-quote="..." data-page="3"
data-cite-type="evidence" href="./paper.pdf.html">paper</a>\`. Every
\`data-*\` attribute lands in the link's \`attrs\` JSON.

## Sidecars

Binary files (PDFs today; more handlers in future) auto-generate an
HTML sidecar at \`.sidecars/<mirrored-path>.html\`. The sidecar is
indexed as \`kind='text'\` and feeds FTS5. Links to the binary work
because the binary itself is also indexed (as \`kind='asset'\`).
Re-run \`arkeon-wiki install-deps\` once per machine to bootstrap the
Python venv used by the PDF extractor.

## API surface — six commands

All POST bodies are JSON; all GET params are URL-encoded.

### POST /query

\`\`\`json
{
  "folder": "iarpa/sources",
  "kinds": ["text"],
  "has_tag": ["status:feedback"],
  "not_tag": ["processed-by:editor"],
  "text": "shannon entropy",
  "limit": 50,
  "offset": 0
}
\`\`\`

All filters are optional and AND-composed. \`has_tag\` / \`not_tag\`
entries may be:
  - \`"key"\` — match by key presence (any value).
  - \`"key:value"\` — match key + value exactly.

\`text\` runs FTS5 MATCH against artifact text content.

Response:

\`\`\`json
{ "artifacts": [...], "total": 42 }
\`\`\`

Each artifact carries \`{ path, kind, label, source_hash, properties,
tags, created_at, updated_at }\`.

### POST /tag

\`\`\`json
{ "path": "iarpa/sources/paper.pdf", "key": "processed-by", "value": "editor" }
\`\`\`

UPSERT. \`value\` is optional (defaults to empty string). Idempotent.

### POST /untag

\`\`\`json
{ "path": "iarpa/sources/paper.pdf", "key": "processed-by" }
\`\`\`

Returns \`{ "ok": true | false }\`.

### GET /tags?path=...

\`\`\`json
{ "path": "...", "tags": { "key": "value", ... } }
\`\`\`

### GET /backlinks?path=...

\`\`\`json
{
  "path": "...",
  "backlinks": [
    {
      "source_path": "iarpa/article.html",
      "link_text": "paper",
      "attrs": { "quote": "...", "page": "3" },
      "created_at": "..."
    }
  ]
}
\`\`\`

### GET /redlinks?folder=...&limit=&offset=

\`\`\`json
{
  "redlinks": [
    { "target_path": "...", "demand": 3, "linked_from": ["...", "..."] }
  ],
  "total": 12
}
\`\`\`

The work-to-be-written queue.

## Reader (catch-all)

  - \`GET /\` — directory listing of the watched root.
  - \`GET /<path>/\` — directory listing of any subfolder.
  - \`GET /<path>\` — serve the file. HTML/MD files get wikilink
    rewriting: unresolved \`<a class="wikilink">\` anchors gain a
    \`redlink\` class so CSS can style them.

## Trigger model

Workers run on whatever cron-like schedule their harness owns.
Each tick:

  1. POST /query with \`not_tag: ["processed-by:<worker-name>"]\` and
     whatever \`folder\` / \`has_tag\` filters fit the worker.
  2. Process each artifact.
  3. POST /tag with \`processed-by:<worker-name>\` so it doesn't pick
     up the same artifact next tick.

New content surfaces because \`syncFile\` indexes new artifacts
without any \`processed-by\` tag — the worker's next tick picks them
up automatically.

## What's NOT here

  - No agent runtime, no write API, no inbox endpoints. Agents read
    files directly via the filesystem; harnesses write files directly
    too (filesystem is truth). Drop a file in the watched root; the
    watcher indexes it.
  - No \`POST /spaces\`. Spaces are just top-level subdirs.
  - No \`/recent\` audit feed. Use \`git log\` or filesystem mtimes.
  - No authentication yet; deferred until a customer shape demands
    it. The daemon binds to 127.0.0.1 by default — override with
    \`ARKEON_WIKI_HOST=0.0.0.0\` to expose cross-host.
`;
