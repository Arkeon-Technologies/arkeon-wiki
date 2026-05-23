// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Static API guide served at `GET /llms.txt` and `GET /help`. Hand-
 * maintained — when you add or change a route, update this file. The
 * smoke test in `llms-txt.test.ts` fails if a known route string is
 * missing, which catches the most common drift.
 */

export const LLMS_TXT = `# arkeon-wiki

A filesystem-first knowledge graph. Point the daemon at a directory; it
watches files, indexes them into SQLite, and treats <a href> links
between HTML wikis as relationship edges. The filesystem is the source
of truth — SQLite is the index, the API is a read/write surface over
that index, and changes to disk are reflected automatically.

This page is the orientation guide for callers (humans and LLMs). It
describes the data model, the canonical flows, and every route. There
is no auth.

================================================================
## Concepts

**Space**: a registered watch directory, identified by name. URLs are
all rooted at the space: \`/{space}/...\`. Names match
\`[a-zA-Z0-9][a-zA-Z0-9._-]*\`, max 100 chars, and cannot collide with
a daemon-level route name (\`health\`, \`ready\`, \`help\`, \`llms.txt\`,
\`spaces\` are reserved). Multiple spaces can coexist on one daemon.

**Entity**: a row in the index for one file. Indexed files have a
\`type\` and a \`kind\`:
  - \`type\`: \`wiki\` (article under \`wiki/**/*.html\`) or \`file\`
    (everything else).
  - \`kind\`: \`text\` (parsed corpus material — what the agents read
    and process) or \`asset\` (binary attachment — image, PDF, audio,
    video, archive — indexed so links to it resolve but never
    entering the agent queues).

Wikis are always \`type='wiki', kind='text'\`, with a \`<title>\` and
optional \`<meta name="X" content="Y">\` tags. Wiki bodies should follow
the four-section shape: \`Question\`, \`Current answer\`, \`Evidence\`,
\`Open threads\`.

Source files are \`type='file', kind='text'\` (markdown, JSON, CSV,
source code, extensionless README, anything passing the text sniff).
Asset files are \`type='file', kind='asset'\` (images, PDFs, audio,
video, archives, fonts, office documents). Asset rows carry
\`{file_type, size_bytes}\` in \`properties\` and have no parsed content.

Queue queries (editor / proposer / connector) pass \`kind='text'\` so
attachments stay out of the work feed. Reverse queries — "what
attachments does this article reference?" — pass \`kind='asset'\`.

Only secrets (\`.env\`, \`.pem\`, …) and OS junk (\`.DS_Store\`, vim swap,
\`.tmp\`) are refused indexing. Use the \`sources/scan\` endpoint to see
what was skipped.

**Relationship**: every internal \`<a href>\` in a wiki becomes an
edge with \`source_path\` → \`target_path\`. Paths are resolved relative
to the article's directory. External URLs (\`https://\`, \`mailto:\`,
\`tel:\`, ...), pure fragments (\`#section\`), and paths that escape
every registered space are NOT recorded as relationships — but the
underlying \`<a>\` tags stay in the file and render normally in the
reader. The relationship graph is the internal corpus only; external
citations aren't surfaced through the API.

**Cross-space links**: a wiki can link to an article in another
registered space via the canonical \`/{otherSpace}/{path}\` href form.
On disk these write as ordinary relative paths (so wikis still open
under \`file://\`); over HTTP the reader rewrites them back to
\`/{otherSpace}/...\` so the link clicks through. In the relationship
graph the edge's \`target_path\` is stored in the canonical
\`/{otherSpace}/{path}\` form. \`GET /{space}/entities/{path}\` returns
inbound citations from any space (each inbound row carries the
linker's home \`space_name\`); cross-space red links are filtered out
of \`GET /{space}/redlinks\` so a writer scoped to space A doesn't try
to fulfill gaps in space B.

**Red link**: a same-space relationship whose \`target_path\` does not
(yet) match an entity row — a link to a future article. Red links are
the queue the \`writer\` agent draws from. See \`GET /{space}/redlinks\`.

**Plan wiki**: a wiki under \`wiki/_plans/...\` with
\`<meta name="kind" content="plan">\`. Authored by the \`proposer\`
agent; lists the gap-articles a given source suggests, with red links.
Plans are real wikis — they appear in the index and you can read them.

**Properties vs tags** (both JSON bags on the entity):
  - \`properties\` is file-derived: rebuilt from \`<meta>\` tags every
    time the file changes. Don't expect tags written here to persist.
  - \`tags\` is agent-applied bookkeeping (e.g.
    \`editor.processed_hash\`, \`proposer.processed_hash\`). Survives
    content edits; cleared only when the file is deleted.

================================================================
## Canonical flows

### Discovery — "what's in this daemon?"
  1. \`GET /spaces\`                           — list spaces + entity counts.
  2. \`GET /{space}/entities?type=wiki&sort=label&limit=200\`
                                              — browse the article index.
  3. \`GET /{space}/entities?type=wiki&sort=updated_at&limit=20\`
                                              — what's been written or
                                                edited most recently.

### Search → read
  1. \`GET /{space}/search?q=KEYWORD\`         — ripgrep across the corpus.
                                                Returns matched paths
                                                with snippets, ranked by
                                                match count. Repeat \`q\`
                                                up to 10 times to OR
                                                patterns. \`?regex=true\`
                                                opts into regex mode.
  2. \`GET /{space}/entities/{path}\`          — metadata + inbound +
                                                outbound for a hit.
  3. \`GET /{space}/entities/{path}?include=content\`
                                              — same plus the file body
                                                from disk. (\`include=
                                                content\` does NOT work
                                                on the list endpoint —
                                                only on the single-entity
                                                endpoint, to avoid
                                                payload bloat.)

### Browsing the graph
  - From any entity, \`outbound[]\` lists what it links to;
    \`inbound[]\` lists who links to it. Walk from there.
  - \`GET /{space}/redlinks\` exposes the unresolved targets — useful
    to find aspirational topics the corpus has gestured at but not yet
    written.

### Reading articles (human-facing HTML)
  - \`GET /\`                                  — daemon landing: spaces
                                                list.
  - \`GET /{space}/\`                          — alphabetical article
                                                index for the space.
  - \`GET /{space}/wiki/{path}\`               — wiki article with
                                                chrome injection and
                                                link classes
                                                (\`arkeon-wiki\`,
                                                \`arkeon-file\`,
                                                \`arkeon-redlink\`).
  - \`GET /{space}/{path}\`                    — fallback: any non-wiki
                                                file in the watch dir
                                                served with the right
                                                Content-Type (markdown,
                                                PDF, images, etc.).

### Operator tasks
  - \`GET /{space}/sources/scan\`              — every file in the watch
                                                dir partitioned into
                                                supported (indexed —
                                                includes both text and
                                                asset kinds) vs
                                                unsupported (junk and
                                                secret-bearing extensions
                                                that are refused). To
                                                see text vs asset within
                                                supported, hit
                                                \`/{space}/entities\` with
                                                \`?kind=text\` or
                                                \`?kind=asset\`.
  - \`GET /{space}/recent\`                    — \`entity_edits\` feed
                                                across humans and
                                                agents.
  - \`POST /{space}/agents/{role}/run\`        — fire one agent role on
                                                demand. Synchronous;
                                                409 if the space is
                                                busy.

### Adding sources (write-back)

Callers can push new source material into the corpus without writing
to the watched directory directly. The standard convention is the
\`/inbox\` endpoint; \`/sources/\` is the path-explicit specialization.

  - \`POST /{space}/inbox\`                    — JSON \`{text, title?,
                                                kind?, tags?}\`. Server
                                                writes the file under
                                                \`sources/inbox/<UTC-
                                                date>/<slug>.<md|txt>\`
                                                and returns the synced
                                                entity. The standard
                                                way to "drop a note,
                                                let the agents pick it
                                                up."
  - \`PUT /{space}/sources/{path}\`            — raw body, caller-chosen
                                                path under \`sources/\`.
                                                409 on existing path
                                                unless
                                                \`?overwrite=true\`.
                                                For programmatic
                                                imports that own their
                                                own naming.

New sources have no \`*.processed_hash\` tag, so the editor agent picks
them up on its next cron tick.

================================================================
## Routes

### Daemon-level

\`GET  /health\`                  — liveness. \`{"status":"ok"}\`.
\`GET  /ready\`                   — readiness (DB reachable).
\`GET  /llms.txt\`                — this document.
\`GET  /help\`                    — alias for \`/llms.txt\`.
\`GET  /\`                        — HTML spaces list (human-facing).

### Spaces

\`GET  /spaces\`                  — \`{spaces: [{name, watch_dir, created_at, entity_count}]}\`.
\`GET  /spaces/{name}\`           — single space.
\`POST /spaces\`                  — register a directory. Body
                                  \`{name, watch_dir}\`. Returns 201
                                  with \`{name, watch_dir}\`. 409 on
                                  name collision.

### Entities

\`GET  /{space}/entities\`
  Filterable listing. Query params:
    \`type\`                       — \`wiki\` | \`file\` | \`wiki,file\`
    \`kind\`                       — \`text\` | \`asset\` | \`text,asset\`
                                   Pass \`kind=text\` on queue queries
                                   so attachments don't surface as work.
    \`label_contains\`             — substring on \`label\`
    \`path_contains\`              — substring on \`source_path\`
    \`inbound_min\` / \`inbound_max\`  — edge-count bounds
    \`outbound_min\` / \`outbound_max\`
    \`updated_since\`              — ISO timestamp
    \`edited_by_role\`             — last edit was by this role
    \`has_tag\` / \`not_has_tag\`    — tag-key presence
    \`tag_equals\`                 — \`key:value\`
    \`tag_current\` / \`tag_outdated\`
                                   — tag value matches/diverges from
                                     current \`source_hash\`
    \`sort\`                       — \`updated_at\` (default) | \`label\`
                                   | \`inbound\` | \`outbound\`
    \`limit\`                      — default 100, max 10000
    \`offset\`
    \`include=counts\`             — adds \`{inbound, outbound}\` per row
  Response: \`{entities: [...], total, limit, offset}\`.

\`GET  /{space}/entities/{path}\`
  Single entity. Returns metadata + \`outbound[]\` + \`inbound[]\`.
    \`?include=content\`           — adds \`content\` (file body from
                                     disk). Use this for reading.

### Relationships and history

\`GET  /{space}/redlinks?limit=&offset=\`
  Red-link queue. \`{redlinks: [{target_path, demand, linked_from:
  string[]}], total, limit, offset}\`. Ranked by \`demand\` (number of
  inbound edges).

\`GET  /{space}/recent?since=&role=&limit=&offset=\`
  \`entity_edits\` feed. Response: \`{space, edits: [{entity_path,
  by_role, edit_kind, edit_note, content_hash, at}]}\`. \`by_role\` is
  one of \`human\`, \`editor\`, \`proposer\`, \`writer\`, \`connector\`.

### Search

\`GET  /{space}/search?q=&type=&limit=&snippets=&regex=\`
  Keyword search via ripgrep. \`q\` repeatable up to 10 times (OR).
  \`type=wiki\` / \`type=file\` to restrict. \`regex=true\` to opt into
  regex mode. \`snippets=N\` to cap snippets per file (default 3).
  Response shape:
    \`{query, keyword: {hits: [{space_name, source_path, type, label,
      match_count, snippets: [{line_number, text}]}], total,
      unmatched_files}}\`.

### Operator

\`GET  /{space}/sources/scan\`
  Walks the watch dir and partitions every file into supported (will
  be indexed — text and asset kinds both count here) vs unsupported
  (silently skipped — junk basenames and secret-bearing extensions).
  Response:
    \`{space, watch_dir, total, supported: {count, by_ext}, unsupported:
      {count, by_ext, examples: {".env": [paths]}}}\`.
  To break "supported" down by kind, use
  \`GET /{space}/entities?kind=text\` and \`?kind=asset\`.

### Write-back

\`POST /{space}/inbox\`
  Add a new source the standard way — server picks the path. Body:
    \`{
       "text":  "...",                  // required, non-empty
       "title": "...",                  // optional, becomes slug
       "kind":  "md" | "txt",           // optional, default "md"
       "tags":  {"k":"v", ...}          // optional, stamped on entity
     }\`
  Writes to \`sources/inbox/<YYYY-MM-DD>/<slug>.<ext>\` (UTC date). With
  \`kind: "md"\` and a \`title\`, prepends a \`# <title>\` heading so the
  file is self-describing on disk. Slug collisions auto-suffix
  (\`-2\`, \`-3\`, ...). Optional \`X-Caller\` header (allowlist
  \`[A-Za-z0-9._-]{1,40}\`, fallback \`"api"\`) sets
  \`entity_edits.by_role\`. 10 MB body cap. 413 on oversized body, 400
  on validation, 404 on missing space.
  Response (201): \`{space, path, entity}\` with the synced entity inline.

\`PUT /{space}/sources/{path}\`
  Path-explicit source write. URL tail is the disk path (always rooted
  in \`sources/\`); raw body is the content. 409 on existing path unless
  \`?overwrite=true\` (which destroys + recreates, emitting two
  \`entity_edits\` rows). Same \`X-Caller\` contract as \`/inbox\`. Wiki
  paths and binary content (NUL byte in first 8 KB AND extension not on
  the text allowlist) are rejected 400. 10 MB body cap.
  Response: \`{space, path, entity, overwrote}\` — 201 if new, 200 if
  \`overwrote: true\`.

### Agents

\`POST /{space}/agents/{role}/run\`
  Fire one agent role on demand. Synchronous — blocks until done.
  Roles: \`editor\`, \`proposer\`, \`writer\`, \`connector\`.
    - \`editor\` — picks one unprocessed source, integrates its claims
      into existing articles via str_replace / insert_at_line, or
      appends red links to Open Threads. Never creates articles.
    - \`proposer\` — runs after \`editor\` has tagged a source. Reads
      the source plus everything that already cites it, writes a plan
      wiki at \`wiki/_plans/{source-path}.html\` listing gap articles
      as red links.
    - \`writer\` — pulls the top-demand red link from the queue, reads
      the plan(s) and sources that pointed at it, creates the new
      article at the target path.
    - \`connector\` — cross-space synthesis finder (newer role; see
      space config for details).
  Response on success: \`{space, role, duration_ms, steps, edits:
  [{path, kind}], skipped, reason, usage, text}\`.
  Errors: \`404\` (unknown role), \`409\` (space is already running a
  role).

### MCP server (stdio, for Claude Desktop and other MCP clients)

The CLI subcommand \`arkeon-wiki mcp\` runs a Model Context Protocol
server over stdio that exposes the routes above as MCP tools, plus
ships the canonical ASK / CAPTURE / SAVE / FETCH flows as MCP prompts.
Designed for per-space binding in \`claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "iarpa": {
      "command": "arkeon-wiki",
      "args": ["mcp"],
      "env": {
        "ARKEON_WIKI_URL": "http://localhost:8186",
        "ARKEON_WIKI_SPACE": "iarpa",
        "ARKEON_WIKI_CALLER": "nick"
      }
    }
  }
}
\`\`\`

Tools (9): \`daemon_status\`, \`list_spaces\`, \`create_space\`,
\`search_wiki\`, \`list_articles\`, \`read_article\`, \`list_redlinks\`,
\`capture_thought\`, \`save_conversation\`.

Prompts (6): \`mode-router\` (auto-detect), \`new-space\`, \`ask\`,
\`capture\`, \`save\`, \`fetch\`. Each prompt expands to the full flow
for that mode. The capture + save prompts emphasize preserving user
content and source material verbatim — the editor agent works on raw
input, not digests.

See \`docs/user/MCP.md\` for the full setup walkthrough.

### Chat (Phase 3, not yet implemented)

\`POST   /{space}/chat\`                       → 501
\`GET    /{space}/chat/{conversation_id}\`     → 501
\`DELETE /{space}/chat/{conversation_id}\`     → 501

================================================================
## Errors

All errors return JSON:
  \`{"error": {"code": "...", "message": "...", "request_id": "...",
              "details": {...}}}\`

\`details\` is optional and only set for codes that carry structured
context. Today's only example: \`space_busy\` populates
\`details.in_flight_role\` so a caller can tell which role is holding
the per-space mutex.

Common codes: \`validation_error\` (400), \`not_found\` (404),
\`space_busy\` (409, agent runs), \`not_implemented\` (501, chat
stubs), \`internal_error\` (500).

================================================================
## Worked example

Suppose a caller wants to answer "What does this corpus say about
question leakage?" against the \`iarpa\` space:

  1. Search:
       GET /iarpa/search?q=leakage&type=wiki&limit=5
  2. Pick the top hit (say \`wiki/how-do-we-prevent-question-leakage.html\`)
     and read it with its outbound graph:
       GET /iarpa/entities/wiki/how-do-we-prevent-question-leakage.html?include=content
  3. Walk inbound to see which articles already cite this answer:
       (use the \`inbound[]\` array on the response)
  4. For unresolved questions in the area, check the red-link queue:
       GET /iarpa/redlinks
  5. For raw-source material the corpus has indexed:
       GET /iarpa/entities?type=file&path_contains=leakage

================================================================
## Notes

  - The filesystem is the source of truth. Editing a file in your
    editor flows back to the index automatically via the file watcher
    (~500ms debounce).
  - \`<a href>\` links to nonexistent targets are red links, not errors.
    Resolution is a LEFT JOIN at query time.
  - Articles render identically under \`file://\` and \`http://\` — the
    reader decorates anchors but never rewrites hrefs.
`;
