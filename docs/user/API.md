# API reference

Default base URL: `http://localhost:8000` (or the port reported by `arkeon-wiki status` for named instances — derived from the instance name as `8000 + sha256(name) mod 999 + 1`).

No auth. JSON responses for the data routes; the reader routes return HTML (documented at the bottom). Errors follow the [error contract](../dev/ERROR_CONTRACT.md).

Routes split into two halves:

- **`/spaces` and `/{space}/...`** — JSON API for programmatic access.
- **`/`, `/{space}/`, `/{space}/wiki/*`, `/{space}/*`** — human-facing reader (HTML).

The reader is mounted last; `/{space}/*` only matches URLs no JSON route has claimed.

---

## Health

### `GET /health`

Liveness. Returns `200` if the process is up.

```json
{ "status": "ok" }
```

### `GET /ready`

Readiness. Returns `200` if SQLite is reachable, `503` otherwise.

---

## Spaces

A space is a registered directory the daemon watches. Spaces are keyed by **name** (the primary key) — there is no separate ULID.

### `POST /spaces`

Register a new space. The file watcher starts in the background; the response returns immediately.

**Body:**

```json
{ "name": "my-notes", "watch_dir": "/Users/me/notes" }
```

`name` must match `[a-zA-Z0-9][a-zA-Z0-9._-]*` and be ≤100 chars (no slashes, no whitespace, no `..` — the name becomes a URL path segment). Collisions return `409`.

**Response:** `201`

```json
{ "name": "my-notes", "watch_dir": "/Users/me/notes" }
```

### `GET /spaces`

List every registered space with its entity count.

```json
{
  "spaces": [
    {
      "name": "my-notes",
      "watch_dir": "/Users/me/notes",
      "created_at": "2026-04-26T18:00:00.000Z",
      "entity_count": 142
    }
  ]
}
```

### `GET /spaces/:name`

Single space + its entity count. Returns `404` if not found.

---

## Entities

Two kinds live in the `entities` table:

- `type='wiki'` — HTML files under `wiki/` with `<title>` + `<meta>` tags.
- `type='file'` — every other indexed file (sources, notes, plain text).

Identity is `(space_name, source_path)` — no separate ID column. Link targets without a matching entity row are **red links**, surfaced via `/{space}/redlinks`.

### `GET /{space}/entities`

Filterable listing scoped to one space.

**Query parameters:**

| Param | Notes |
|---|---|
| `type` | Comma-separated: `wiki`, `file`, or both. Omit to include all. |
| `label_contains` | Case-insensitive substring match on `label`. |
| `path_contains` | Case-insensitive substring match on `source_path`. |
| `inbound_min`, `inbound_max` | Inclusive bounds on inbound link count. `inbound_max=0` finds entities nothing points at. |
| `outbound_min`, `outbound_max` | Inclusive bounds on outbound link count. |
| `updated_since` | ISO timestamp; only entities with `updated_at >=` this. |
| `edited_by_role` | Filter on the most-recent edit's `by_role` (joins `entity_edits`). Use `human` for filesystem-driven edits. |
| `has_tag`, `not_has_tag` | Filter on the presence/absence of a top-level key in `entities.tags`. Dotted keys (`editor.processed_hash`) are handled verbatim. |
| `tag_equals` | `key:value` — match entities whose `tags[key] == value`. Splits on the first colon, so values may contain colons. |
| `tag_current` | Key name. Match entities where the stored tag value equals the entity's current `source_hash` — "already processed at the current content." |
| `tag_outdated` | Inverse of `tag_current`: tag absent OR value doesn't match — covers "never processed" + "stale" in one query. |
| `sort` | `updated_at` (DESC, default), `label` (ASC), `inbound` (DESC), or `outbound` (DESC). |
| `include` | Comma-separated. `counts` attaches `{inbound, outbound}` to each row. |
| `limit` | Default `100`, max `10000`. |
| `offset` | Pagination offset. |

**Response:**

```json
{
  "entities": [
    {
      "space_name": "my-notes",
      "source_path": "wiki/photosynthesis.html",
      "type": "wiki",
      "label": "Photosynthesis",
      "source_hash": "ab12cd...",
      "properties": { "short_description": "How plants convert light to chemical energy." },
      "tags": { "editor.processed_hash": "ab12cd..." },
      "created_at": "2026-04-26T18:00:00.000Z",
      "updated_at": "2026-04-26T18:00:00.000Z",
      "last_edited_by": "writer",
      "counts": { "inbound": 3, "outbound": 5 }
    }
  ],
  "total": 142,
  "limit": 100,
  "offset": 0
}
```

`properties` (file-derived: `<meta>` tags + `file_type`) and `tags` (agent-applied bookkeeping) are stored as JSON text in SQLite but parsed before being returned. `counts` is only present with `include=counts`. `last_edited_by` is always present and is `null` if no edits have been recorded.

### `GET /{space}/entities/*`

Single entity by path. The path is everything after `/entities/` — e.g. `/my-notes/entities/wiki/photosynthesis.html` resolves to the entity at `wiki/photosynthesis.html` in space `my-notes`. Returns `404` if the path is unknown.

**Query parameters:**

| Param | Notes |
|---|---|
| `include` | Comma-separated. `content` reads the file from disk and adds a `content` field with the UTF-8 body (or `null` if unreadable). |

**Response:** the entity row plus `inbound` and `outbound` arrays of relationships:

```json
{
  "space_name": "my-notes",
  "source_path": "wiki/photosynthesis.html",
  "type": "wiki",
  "label": "Photosynthesis",
  "source_hash": "ab12cd...",
  "properties": { "short_description": "..." },
  "tags": {},
  "created_at": "...",
  "updated_at": "...",
  "last_edited_by": "writer",
  "inbound": [
    { "source_path": "wiki/plants.html", "link_text": "photosynthesis" }
  ],
  "outbound": [
    { "target_path": "wiki/chloroplast.html", "link_text": "chloroplasts" }
  ]
}
```

There is no separate "history" endpoint — see `/{space}/recent` for the edit feed.

---

## Red links

### `GET /{space}/redlinks`

Link targets in this space with no matching entity row, aggregated by `target_path` and ranked by demand (the number of relationships pointing at them). The writer drains this queue.

**Query parameters:**

| Param | Default | Notes |
|---|---|---|
| `limit` | `100` | Max `10000`. |
| `offset` | `0` | Pagination offset. |

**Response:**

```json
{
  "redlinks": [
    {
      "target_path": "wiki/why-grief-feels-sweet.html",
      "demand": 3,
      "linked_from": [
        "wiki/_plans/Augustine__book-04.html",
        "wiki/the-restless-heart.html",
        "wiki/_plans/Augustine__book-09.html"
      ]
    }
  ],
  "total": 17,
  "limit": 100,
  "offset": 0
}
```

`linked_from` carries the last 3 source paths pointing at each target (most recent first).

---

## Recent edits

### `GET /{space}/recent`

The `entity_edits` feed for this space, newest first.

**Query parameters:**

| Param | Default | Notes |
|---|---|---|
| `since` | — | ISO timestamp; only edits at-or-after this. |
| `role` | — | Restrict to a single `by_role` (e.g. `human`, `writer`, `editor`). |
| `limit` | `50` | Max `500`. |
| `offset` | `0` | Pagination offset. |

**Response:**

```json
{
  "space": "my-notes",
  "edits": [
    {
      "entity_path": "wiki/photosynthesis.html",
      "by_role": "writer",
      "edit_kind": "create",
      "edit_note": null,
      "content_hash": "ab12cd...",
      "at": "2026-04-26T19:30:00.123"
    }
  ]
}
```

`at` carries millisecond precision (sourced from `strftime('%f')`) so same-second writes don't collide.

---

## Search

### `GET /{space}/search`

Keyword search via ripgrep, scoped to one space. The daemon spawns ripgrep against the space's `watch_dir`, parses `--json` output, and joins matched paths back to entities. Ranked by `match_count` descending.

**Query parameters:**

| Param | Default | Notes |
|---|---|---|
| `q` | — | **Required.** Repeatable up to 10 times to OR patterns in one pass (`?q=foo&q=bar`). |
| `type` | — | Comma-separated entity types to restrict hits to (`wiki`, `file`). |
| `limit` | `20` | Max `200`. |
| `snippets` | `3` | Max snippets per file. `0` returns counts only. Snippets are truncated to 240 chars. |
| `regex` | `false` | When `true`, treat each `q` as a regular expression. |

**Response:**

```json
{
  "query": "shannon",
  "keyword": {
    "hits": [
      {
        "space_name": "my-notes",
        "source_path": "wiki/claude-shannon.html",
        "type": "wiki",
        "label": "Claude Shannon",
        "match_count": 7,
        "snippets": [
          { "line_number": 12, "text": "Claude Shannon was the father..." }
        ]
      }
    ],
    "total": 1,
    "unmatched_files": 0
  }
}
```

`query` echoes the input shape (string or string array). `unmatched_files` counts files ripgrep matched but for which no entity exists in the index — usually a watcher lag.

---

## Chat (Phase 3 stubs)

Three routes are reserved for the chat-with-article feature. All currently return `501`:

```
POST   /{space}/chat
GET    /{space}/chat/:conversation_id
DELETE /{space}/chat/:conversation_id
```

The `conversations` and `conversation_messages` tables are in place; the handlers ship in Phase 3.

---

## Reader (HTML)

The reader serves human-facing HTML pages. Always mounted last, so it never shadows a JSON route.

| Route | Returns |
|---|---|
| `GET /` | Alphabetical list of registered spaces with per-space entity counts. |
| `GET /{space}` | `301` redirect to `/{space}/`. |
| `GET /{space}/` | Article index — `type='wiki'` entries alphabetical by `label`, with `short_description` subtitles. |
| `GET /{space}/wiki/*` | Wiki article with `<div id="arkeon-chrome">` injected and link classes (`arkeon-wiki`, `arkeon-file`, `arkeon-redlink`). Anchors are decorated, not rewritten — the same HTML opens identically over `file://`. |
| `GET /{space}/*` | Static-file fallback for non-wiki paths inside the watch dir. Markdown → `text/markdown`, PDF → `application/pdf`, images → `image/*`, etc. Path-traversal escapes return `404`. |

URL structure mirrors disk structure within a space: `wiki/foo.html` on disk → `/{space}/wiki/foo.html` over HTTP.

---

## Errors

Every non-2xx response uses this shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "q is required",
    "request_id": "req_..."
  }
}
```

See [docs/dev/ERROR_CONTRACT.md](../dev/ERROR_CONTRACT.md) for the full code table.
