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

    Tag KEYS reject \`:\` (400 \`reserved_character\`). The colon
    is the key/value separator in \`has_tag\` / \`not_tag\` query
    specs — a literal colon in the key would store fine but then
    collide on read with the (key, value) split. Put the colon
    in the request shape (\`{key: "status", value: "published"}\`),
    not in the key. Values may contain colons.

    "No tag = unprocessed" is the trigger model.

  - **links** \`(source_path, target_path, link_text, attrs)\` —
    every \`<a class="wikilink">\` (HTML) or \`[[X]]\` (Markdown) the
    extractor resolved. \`attrs\` is a JSON map of \`data-*\`
    attributes for citation metadata (data-quote, data-page,
    data-cite-type, …). Targets with no matching artifact are
    redlinks.

  - **fts_artifacts** — FTS5 over text-kind artifact contents.
    Populated by syncFile; queried via POST /query \`{text}\`.

## HTML \`<head>\` extraction

The first \`<title>\` element populates the artifact's top-level
\`label\` column. Every \`<meta name="X" content="Y">\` lands in
\`properties[X]\`, EXCEPT for two reserved names:

  - \`title\` — would shadow the column derived from \`<title>\`.
  - \`label\` — would shadow the artifact's \`label\` column.

Both are silently stripped so a harness walking \`artifact.properties\`
never sees a value that doesn't match the top-level field. Use any
other meta name (\`status\`, \`topic\`, \`source\`, …) freely.

Sidecars (\`.sidecars/<binary>.html\`) get their label from the
binary's filename basename, NOT the embedded \`<title>\` — that keeps
\`asset.label\` and \`sidecar.label\` aligned so harnesses dereferencing
\`asset.properties.sidecar_path\` see consistent labels.

## Link conventions

HTML: \`<a class="wikilink" href="./topic-x">topic X</a>\`. Only
anchors with \`wikilink\` in their class list become graph edges;
other \`<a>\` elements render as ordinary HTML. Hrefs resolve
relative to the source file's directory (browser-style):

  - \`./topic-x.html\` from \`iarpa/notes.html\` → \`iarpa/topic-x.html\`
  - \`topic-x.html\` from \`iarpa/notes.html\` → \`iarpa/topic-x.html\`
    (the leading \`./\` is decorative; both forms identical)
  - \`../chartbook/x.html\` from \`iarpa/notes.html\` → \`chartbook/x.html\`
  - \`/x.html\` → dropped (server-absolute paths are out of scope —
    the watched root has no notion of "server root")
  - \`https://...\` (or any \`scheme:\`) → dropped
  - paths that escape the watched root → dropped

Markdown: \`[[X]]\` resolves by basename match — looks for any
artifact whose basename (with or without extension) equals \`X\`
case-insensitively.

  - **Exactly one match** → resolves to that artifact's path.
  - **Zero matches** → stays unresolved; target stored as the
    literal slug. Auto-converges if/when exactly one matching
    artifact lands (during initial reconcile or via live watcher
    event).
  - **Multiple matches** → stays unresolved (ambiguous).
    Disambiguate with \`[[folder/X]]\` or \`[[folder/X.html]]\`.

\`[[folder/X]]\` is treated as a path-form: normalized relative to
the source file's directory if it starts with \`./\` or \`../\`,
otherwise relative to the watched root. \`[[X|Display]]\` carries
an alias for \`link_text\`.

**Same basename in different folders is the norm, not a
collision.** \`iarpa/wiki.html\` and \`chartbook/wiki.html\` are two
distinct artifacts, each with its own backlink graph. An MD
\`[[wiki]]\` from anywhere in the corpus only resolves if exactly
one \`wiki.*\` exists. Write \`[[iarpa/wiki]]\` or
\`[[chartbook/wiki]]\` for an unambiguous cross-folder link. The
HTML equivalent from a sibling-folder source is
\`<a class="wikilink" href="../chartbook/wiki.html">\`.

**Prefer \`[[folder/X]]\` over HTML's \`../folder/X.html\` for
cross-folder links.** The MD form is stable when the SOURCE file
moves between folders (the resolver walks from the source's
directory; the path-form normalizes consistently). HTML's
\`../folder/X.html\` form breaks when you move the source because
\`../\` is now interpreted from a different starting point.

Citation metadata: \`<a class="wikilink" data-quote="..." data-page="3"
data-cite-type="evidence" href="./paper.pdf.html">paper</a>\`. Every
\`data-*\` attribute lands in the link's \`attrs\` JSON with the
\`data-\` prefix STRIPPED — \`data-quote\` → \`attrs.quote\`,
\`data-cite-type\` → \`attrs["cite-type"]\`.

## Sidecars

Binary files (PDFs today; more handlers in future) auto-generate an
HTML sidecar at \`.sidecars/<mirrored-path>.html\`. The sidecar is
indexed as \`kind='text'\` and feeds FTS5. Links to the binary work
because the binary itself is also indexed (as \`kind='asset'\`).
Run via the arkeon-wiki Docker image
(\`ghcr.io/arkeon-technologies/arkeon-wiki\`) to get PDF extraction —
PyMuPDF ships pre-installed in the image.

**Tag the sidecar, not the binary.** Worker \`processed-by-<name>\`
tags belong on the SIDECAR (\`.sidecars/X.html\`), not the binary
asset. Asset artifacts are \`kind='asset'\`, invisible to any
\`kinds: ["text"]\` query — tagging them does nothing the next tick
will notice. Tag the sidecar instead and your worker's gate query
will exclude the entry correctly.

The asset's \`properties.sidecar_path\` carries the convention path,
so harnesses can dereference \`asset.properties.sidecar_path\` to
get the right target without hard-coding the convention.

**Reserved tag: \`extracted_by\`.** Every sidecar gets an
\`extracted_by\` tag set automatically by the extractor runner
(value: the handler name, e.g. \`pymupdf\`). Used internally to
distinguish handler-generated sidecars from hand-written ones
during re-extraction. Harnesses can read it for provenance, but
should NOT use it as a worker gate or overwrite it — use a
\`processed-by-<worker>\` key for your own bookkeeping. The
\`extracted_by\` key is reserved for the extractor pipeline.

## API surface

Six substrate commands (\`/query\`, \`/tag\`, \`/untag\`, \`/tags\`,
\`/backlinks\`, \`/redlinks\`) + \`/stats\` + \`/reconcile\`, plus the
op endpoints (\`/health\`, \`/ready\`) and this doc surface
(\`/llms.txt\`, \`/help\`). All POST bodies are JSON; all GET params
are URL-encoded.

POST endpoints validate strictly: a malformed JSON body returns
\`400 invalid_json\` (never silently treated as empty); any
top-level key that isn't in the documented field set returns
\`400 unknown_field\`. A typo like \`notag\` instead of \`not_tag\`
errors loudly rather than returning the unfiltered corpus.

### POST /query

\`\`\`json
{
  "folder": "iarpa",
  "kinds": ["text"],
  "has_tag": ["status:feedback"],
  "not_tag": ["processed-by-editor"],
  "text": "shannon entropy",
  "order_by": "updated_at",
  "order": "desc",
  "limit": 50,
  "offset": 0
}
\`\`\`

\`order_by\` is one of \`updated_at\` (default), \`created_at\`,
or \`path\`. \`order\` is \`asc\` | \`desc\` — defaults to \`desc\`
for time columns and \`asc\` for \`path\`.

All filters are optional and AND-composed. \`has_tag\` / \`not_tag\`
entries may be:
  - \`"key"\` — match by key presence (any value).
  - \`"key:value"\` — match key + value exactly.

\`text\` runs SQLite FTS5 MATCH against artifact text content.
Space-separated tokens are AND'd by default (\`shannon entropy\`
matches docs containing both terms); wrap in quotes for an exact
phrase (\`"shannon entropy"\` matches the literal phrase only).

**Tokenizer**: \`porter unicode61\` — Porter-stemmed, Unicode-aware.
Stemming means \`chokepoint\` matches \`chokepoints\`, \`indexing\`
matches \`indexed\`, etc. Precision-sensitive callers wanting an
exact-form match should wrap the term in double quotes
(\`"chokepoint"\` won't match \`chokepoints\`).

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

Request:
\`\`\`json
{ "path": "iarpa/sources/paper.pdf", "key": "processed-by-editor" }
\`\`\`

Response:
\`\`\`json
{ "ok": true, "path": "...", "key": "...", "existed": true | false }
\`\`\`

\`ok\` is always true — removing a non-existent tag is a no-op,
not an error. \`existed\` distinguishes the two cases so a worker
can detect whether something was actually cleared (useful for
re-entrancy / cleanup scripts).

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
      "synced_at": "..."
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

\`synced_at\` is per-row last-sync time, NOT first-anchor-creation
history: outbound links get DELETE+INSERTed wholesale on every
source re-extraction, so all of an article's backlinks share a
\`synced_at\` after any change to that article. Use the source
artifact's \`updated_at\` if you need "when did the source last
change."

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

The work-to-be-written queue. One row = one concrete unit of work.

**Aggregation mirrors the resolver.** \`/redlinks\` groups anchors the
same way the substrate resolves links, so a row represents the
anchors that WILL resolve when a single file lands:

  - **Each unique fs-path target is its own row.** HTML
    \`<a class="wikilink" href="...">\` always lands as an fs-relative
    path (e.g. \`iarpa/missing.html\`). \`iarpa/wiki.html\` and
    \`chartbook/wiki.html\` are two distinct redlinks — creating one
    file does NOT resolve anchors that named the other.
  - **MD slug redlinks** (\`[[X]]\` with no slash or extension) merge
    into a fs-path row only when the slug's basename has EXACTLY ONE
    fs-path match in the queue — the same condition under which
    \`[[X]]\` would auto-resolve once the file lands. Zero matches:
    slug stays as its own row (target=\`X\`); two+ matches: slug stays
    standalone too (ambiguous; the resolver would punt the same way).

So a \`[[chloroplast]]\` slug + a single \`iarpa/chloroplast.html\`
fs-path anchor surface as one row whose \`demand\` sums both anchors
and whose \`linked_from\` unions both source files. But two cross-
folder fs-paths sharing a basename (e.g. \`iarpa/wiki.html\` and
\`chartbook/wiki.html\`) stay as two rows — plus a third row for any
\`[[wiki]]\` slug, because the slug is ambiguous and can't be
attributed to either fs-path safely.

Branch on \`target_path.includes("/")\` ⇒ fs-relative path (suggests
where to create the file); otherwise ⇒ MD slug (resolves by basename
anywhere under the watched root once exactly one matching file
lands).

### GET /stats

\`\`\`json
{
  "artifacts": { "total": 1234, "text": 1180, "asset": 54 },
  "links": 4321,
  "redlinks": 17,
  "tag_keys": 8
}
\`\`\`

Constant-time corpus size snapshot. Useful for dashboards or for
discovery-loop sanity checks ("did the watcher actually pick up
my new files?") without paginating through \`/query\`.

### POST /reconcile

\`\`\`json
{}
\`\`\`

Force a full re-walk of the watched root: re-sync every eligible
file, prune any \`artifacts\` row whose path no longer exists on
disk. The same operation runs at startup and on a 30s timer in
the background — this endpoint is the force-now button.

Response:

\`\`\`json
{
  "ok": true,
  "created": 0,
  "updated": 0,
  "unchanged": 3217,
  "removed": 195,
  "failed": 0,
  "took_ms": 184,
  "coalesced": false
}
\`\`\`

Why this exists: \`node:fs.watch\` (FSEvents on macOS, inotify on
Linux, ReadDirectoryChangesW on Windows) silently drops events
under bulk filesystem load. A \`mv *.html corpus/\` over a few
thousand files can leak a percentage of unlink events, leaving
stale rows at the old paths. The daemon catches this drift on the
periodic sweep (default 30s, configurable via
\`ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS\`, 0 to disable). Call
\`/reconcile\` to heal immediately.

\`failed\` counts files whose \`syncFile\` call threw — the sweep
continues past errors so one corrupt file doesn't stop the heal,
but the count surfaces here so a harness gating on \`/reconcile\`
can distinguish "clean sweep" from "N silently-failed syncs."

Sidecar extraction is dispatched in the same sweep: any ingestable
binary whose \`.sidecars/<mirrored>.html\` is missing on disk gets
a fresh extraction call (fire-and-forget). This handles the PDF
case of the headline bug — a batch of binaries dropped during a
watcher-deaf window get their sidecars built on the next reconcile
rather than waiting for a daemon restart.

\`coalesced: true\` means another reconcile was already in flight
when this request arrived and the response rode that sweep's
result — a single-flight lock ensures concurrent calls don't
re-walk the disk. From the caller's perspective the contract is
the same: when this response returns, the index is consistent
with disk.

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
  3. POST /tag with
     \`{ key: "processed-by-<worker-name>", value: <artifact.source_hash> }\`
     so it doesn't pick up the same artifact next tick.

New content surfaces because \`syncFile\` indexes new artifacts
without any \`processed-by-*\` tag — the worker's next tick picks them
up automatically.

**Detecting edits.** "No tag = unprocessed" only catches new files.
To catch *edited* files, store \`artifact.source_hash\` as the tag
value and add a second pass:

  - Pass 1: \`not_tag: ["processed-by-<worker>"]\` — picks up new
    artifacts (no tag at all).
  - Pass 2: \`has_tag: ["processed-by-<worker>"]\` — yields every
    tagged artifact. For each, compare the tag's value (in the
    \`/tags\` response or by tracking it locally) against the
    artifact's current \`source_hash\`. If they differ, the source
    was edited since the last run — re-process and UPSERT the tag
    with the new hash. \`POST /tag\` returns \`action: "updated"\` on
    a hash overwrite, confirming the collision.

Without this pattern an edited source keeps its stale tag forever
and the worker silently skips updated content.

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
