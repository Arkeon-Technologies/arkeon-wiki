# API reference

Default base URL: `http://localhost:8000` (or the port reported by `arkeon-wiki status` for named instances).

No auth. No content negotiation — every endpoint returns JSON. Errors follow the [error contract](../dev/ERROR_CONTRACT.md).

---

## Health

### `GET /health`

Liveness. Always returns `200` if the process is up.

```json
{ "status": "ok" }
```

### `GET /ready`

Readiness. Returns `200` if SQLite is reachable, `503` otherwise.

```json
{ "status": "ready" }
```

---

## Spaces

A space is a registered directory the daemon watches.

### `POST /spaces`

Register a new space. The file watcher starts in the background; the response returns immediately.

**Body:**

```json
{ "name": "my-notes", "watch_dir": "/Users/me/notes" }
```

**Response:** `201`

```json
{ "id": "01JSG...", "name": "my-notes", "watch_dir": "/Users/me/notes" }
```

### `GET /spaces`

List all spaces with entity counts.

```json
{
  "spaces": [
    {
      "id": "01JSG...",
      "name": "my-notes",
      "watch_dir": "/Users/me/notes",
      "created_at": "2026-04-26T18:00:00.000Z",
      "entity_count": 142
    }
  ]
}
```

### `GET /spaces/:id`

Single space. Returns `404` if not found.

---

## Wikis

A wiki is a markdown file under `wiki/` with YAML frontmatter. Source files (everything else the watcher picks up) are indexed too but not exposed over HTTP — they are an internal substrate for the agent runtime to read from. If a use case appears, a parallel `/sources` endpoint will be added then.

### `GET /wikis`

List wikis with frontmatter-aware filters and join-in counts.

**Query parameters:**

| Param | Default | Notes |
|---|---|---|
| `space_id` | — | Filter to one space. |
| `subject_type` | — | Match `properties.subject_type` exactly (e.g. `person`, `organization`). |
| `status` | — | Match `properties.status` exactly. Free-form — whatever values you put in your wikis (e.g. `draft`, `review`, `published`). |
| `label_contains` | — | Case-insensitive substring match on `label`. "Baker Street" matches "221B Baker Street". |
| `sort` | `updated_at` | `updated_at` (DESC) or `label` (ASC, case-insensitive). |
| `include` | — | Comma-separated. `relationships` adds a top-level `relationships` array (every edge touching a matched wiki). `counts` attaches `{ incoming_links, outgoing_links }` to each wiki. |
| `limit` | `100` | Max `10000`. |
| `offset` | `0` | Pagination offset. |

**Response:**

```json
{
  "wikis": [
    {
      "id": "01JSG...",
      "space_id": "01JSF...",
      "label": "Claude Shannon",
      "source_path": "wiki/person/claude-shannon.md",
      "properties": { "subject_type": "person", "birth_year": 1916 },
      "created_at": "2026-04-26T18:00:00.000Z",
      "updated_at": "2026-04-26T18:00:00.000Z",
      "counts": {
        "incoming_links": 5,
        "outgoing_links": 1
      }
    }
  ],
  "total": 142,
  "limit": 100,
  "offset": 0
}
```

`properties` is stored as JSON text in SQLite but the API parses it before returning, so callers get an object (or array, or `null`) — not a string. `counts` is only present when `include=counts`.

### `GET /wikis/:id`

Properties plus incoming and outgoing relationships. Returns `404` if `id` doesn't refer to a wiki.

**Query parameters:**

| Param | Notes |
|---|---|
| `include` | Comma-separated. `content` reads the file from disk and adds a `content` field. |

**Response:**

```json
{
  "id": "01JSG...",
  "space_id": "01JSF...",
  "label": "Claude Shannon",
  "source_path": "wiki/person/claude-shannon.md",
  "properties": { "subject_type": "person" },
  "created_at": "2026-04-26T18:00:00.000Z",
  "updated_at": "2026-04-26T18:00:00.000Z",
  "relationships": {
    "outgoing": [
      {
        "id": "01JSH...",
        "target_id": "01JSI...",
        "predicate": "references",
        "link_text": "Bell Labs",
        "link_path": "../organization/bell-labs.md",
        "target_label": "Bell Labs",
        "target_type": "wiki",
        "target_source_path": "wiki/organization/bell-labs.md"
      }
    ],
    "incoming": []
  }
}
```

With `?include=content`, a `content` field is added with the file's full UTF-8 text (or `null` if the file isn't readable).

### `DELETE /wikis/:id`

Remove a wiki from the index. The file on disk is **not** deleted — but if it still exists, the watcher will re-index it on the next change. Returns `404` if `id` doesn't refer to a wiki.

```json
{ "deleted": true, "id": "01JSG...", "label": "Claude Shannon" }
```

---

## Search

### `GET /search`

Keyword search via ripgrep. The daemon spawns ripgrep against each space's `watch_dir`, parses `--json` output, and joins the matched paths back to entities. Results are ranked by `match_count` descending; ties broken by `entity_id`.

**Query parameters:**

| Param | Default | Notes |
|---|---|---|
| `q` | — | **Required.** Literal substring by default. |
| `space_id` | — | Restrict to one space. Omit to search every registered space. |
| `limit` | `20` | Max `200`. |
| `snippets` | `3` | Max snippets per file. `0` returns counts only. Snippets are truncated to 240 chars. |
| `regex` | `false` | When `true`, treat `q` as a regular expression. |

ripgrep runs with `--smart-case`, skips `.arkeon/`, `.git/`, and `node_modules/`, and only searches files of types `md`, `txt`, `json`, `csv`, `xml`, `html`, `rst`.

**Response:**

```json
{
  "query": "shannon",
  "hits": [
    {
      "entity_id": "01JSG...",
      "space_id": "01JSF...",
      "type": "wiki",
      "label": "Claude Shannon",
      "source_path": "wiki/person/claude-shannon.md",
      "match_count": 7,
      "snippets": [
        { "line_number": 12, "text": "Claude Shannon was the father..." },
        { "line_number": 34, "text": "Shannon's 1948 paper..." }
      ]
    }
  ],
  "unmatched_files": 0
}
```

`unmatched_files` counts files ripgrep matched but for which no entity exists in the index — usually means the watcher hasn't caught up yet, or the file was matched outside the indexed file types.

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
