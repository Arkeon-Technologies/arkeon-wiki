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
    \`(path, key)\` is the PK; each artifact has at most one value
    per key. Two conventions coexist:

      • **Worker gates** — one key per worker, e.g.
        \`processed-by-editor\`, \`processed-by-writer\`. Workers
        query for artifacts MISSING their own key. **Do not** use
        a single \`processed-by\` key with the worker name as
        value — that would let worker A's tag clobber worker B's.

      • **Content labels** — one key shared across artifacts,
        e.g. \`status:feedback\`, \`source:gmail-forward\`,
        \`topic:us-china\`. The \`key:value\` string form is for
        these where the value carries meaning across artifacts.

    "No tag = unprocessed" is the trigger model.

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
  "folder": "iarpa",
  "kinds": ["text"],
  "has_tag": ["status:feedback"],
  "not_tag": ["processed-by-editor"],
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

**Folder note**: sidecar HTMLs for binaries live under
\`.sidecars/<mirrored-path>.html\` — OUTSIDE the source folder. A
worker that queries \`folder: "iarpa/sources"\` will see source MDs
but NOT the auto-generated PDF/Word sidecars. To process all
unprocessed text in a top-level dir including sidecars, drop the
folder filter and rely on the \`not_tag\` gate
(\`{ kinds: ["text"], not_tag: ["processed-by-editor"] }\`) — the
"no tag = unprocessed" model surfaces every text artifact that
needs work, sidecars included.

Response:

\`\`\`json
{ "artifacts": [...], "total": 42 }
\`\`\`

Each artifact carries \`{ path, kind, label, source_hash, properties,
tags, created_at, updated_at }\`.

### POST /tag

Request:
\`\`\`json
{ "path": "iarpa/sources/paper.pdf", "key": "processed-by-editor", "value": "abc123" }
\`\`\`

Response:
\`\`\`json
{
  "ok": true,
  "path": "iarpa/sources/paper.pdf",
  "key": "processed-by-editor",
  "value": "abc123",
  "previous_value": null,
  "action": "created"
}
\`\`\`

UPSERT. \`value\` is optional (defaults to empty string). Idempotent.

\`action\` is one of:
  - \`"created"\` — key didn't exist; \`previous_value\` is null.
  - \`"updated"\` — key existed with a different value; \`previous_value\`
    carries it. Useful for collision detection: if worker A tags and
    worker B sees a foreign \`previous_value\`, B knows it stomped A.
  - \`"unchanged"\` — key existed with the same value; no write happened.

One key per worker — see the "tags" section above for why
\`processed-by-<worker>\` keys coexist but a shared \`processed-by\`
key with worker-name values does not.

### POST /untag

\`\`\`json
{ "path": "iarpa/sources/paper.pdf", "key": "processed-by-editor" }
\`\`\`

Returns \`{ "ok": true | false }\`.

### GET /tags?path=...

\`\`\`json
{ "path": "...", "tags": { "key": "value", ... } }
\`\`\`

### GET /backlinks?path=...

\`\`\`json
{
  "path": "iarpa/sources/paper.pdf",
  "exists": true,
  "demand": 2,
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

Works uniformly for any \`path\` — resolved artifacts and unresolved
redlink targets alike. \`exists: false\` means the path isn't in
\`artifacts\` (it's a redlink target); \`exists: true\` means it is.
\`demand\` is the anchor count, matching \`/redlinks\` semantics.

One row per anchor, not per (source, target) pair: an article that
cites the same source twice with different \`data-quote\` /
\`data-page\` values appears twice in \`backlinks\`.

\`/redlinks\` is the aggregated complement: rather than answering
"who links to ONE specific path" (this endpoint), it answers
"what unresolved targets exist in folder F, sorted by demand?"
A worker harness inspecting one artifact uses this endpoint; a
discovery loop building a work queue uses \`/redlinks\`.

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

  1. POST /query with \`not_tag: ["processed-by-<worker-name>"]\` and
     whatever \`kinds\` / \`has_tag\` filters fit the worker.
  2. Process each artifact.
  3. POST /tag with \`{ key: "processed-by-<worker-name>", value: <hash-or-ts> }\`
     so it doesn't pick up the same artifact next tick.

New content surfaces because \`syncFile\` indexes new artifacts
without any \`processed-by-*\` tag — the worker's next tick picks them
up automatically.

**Sidecars and folder scoping**: don't reach for \`folder\` when the
intent is "process all unprocessed text in space X." PDF/Word
sidecars for \`X/sources/foo.pdf\` land at \`.sidecars/X/sources/foo.pdf.html\`,
which a \`folder: "X"\` query excludes. Use the tag gate alone
(\`{ kinds: ["text"], not_tag: ["processed-by-<worker>"] }\`); the
"no tag = unprocessed" model is the source of truth for what's
left to do, and it covers both source files and their sidecars.

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
