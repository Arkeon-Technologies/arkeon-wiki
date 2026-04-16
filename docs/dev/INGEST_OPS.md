# Bulk Ingestion via `arke.ops/v1`

`POST /ops` is the canonical path for creating multiple entities and relationships in one atomic request. This document describes the format conventions, the ref system, and the extensibility contract — everything that isn't derivable from the Zod schemas in `packages/arkeon/src/server/lib/ops-schema.ts` or the route definition in `packages/arkeon/src/server/routes/ops.ts`.

For the HTTP surface (field names, types, error codes) see `GET /help/POST/ops`.

## When to use it

Use `POST /ops` whenever you are creating more than one thing. A single-entity create via `POST /entities` is fine for small one-off edits; everything else — extraction output, bulk imports, any workflow that builds a subgraph — should go through `/ops`.

The reason isn't just efficiency. The format is designed around what LLMs are good at: writing linear, forward-only operations and inlining context as they go. The per-resource endpoints force a "collect everything first, then relate it all at the end" pattern that wastes working memory and leads to broken refs.

## The two-ref system

Every source/target on a relate op is either:

| Form | Example | Meaning | Scope |
|------|---------|---------|-------|
| `@local` ref | `@jane` | An entity being created *in this same batch* | One request |
| ULID | `01ARZ3NDEKTSV4RRFFQ69G5FAV` | An existing entity from a previous batch | Persistent |
| `arke:`-prefixed ULID | `arke:01ARZ3...` | Same as bare ULID (alternate form) | Persistent |

**`@local` refs do not persist across requests.** After a batch commits, the response `created` array maps each `@ref` to its new ULID. Use those ULIDs directly in the next request. If you send a second batch with `@jane` again, that's a brand-new entity — not a reference back to the original.

Put another way: the `@` sigil says "I just named this." The absence of a sigil says "this exists already."

### Why mark locals instead of globals

Most refs in a mature batch will be to pre-existing entities — a small number of new entities get created with @refs, then attached to a much larger existing graph. Marking the short-lived case (`@name`) rather than the long-lived case (bare ULID) keeps the bulk of the payload short and draws the eye to the temporary scaffolding.

The bare ULID form is also continuous with the existing `arke:` URI convention documented in [ENTITY_REFS.md](./ENTITY_REFS.md) — an ops envelope can reuse any ULID that appears in an entity's properties without transformation.

## Define before reference

The parser walks ops in order. An `@ref` used as source or target must have been defined by an *earlier* `entity` op in the same ops array. Forward references are rejected.

```json
{
  "format": "arke.ops/v1",
  "ops": [
    { "op": "relate", "source": "@jane", "target": "@acme", "predicate": "leads" },
    { "op": "entity", "ref": "@jane", "type": "person" }
  ]
}
```

The relate op at index 0 fails because `@jane` isn't defined yet. Rearrange to put entity ops first, or interleave naturally ("create Jane, relate Jane, create Bob, relate Bob, …").

This rule is load-bearing for LLM correctness. LLMs that emit operations in reading order rarely have broken refs; LLMs forced to emit entities-then-relationships have to hold the entire ref table in working memory. Define-before-reference lines up with how they naturally write.

## Inline properties — the extensibility contract

Every field on an op beyond the reserved keys is automatically stored as a property on the created entity or relationship. No schema changes needed to carry new metadata.

Reserved keys:

- `entity` ops: `op, ref, type, space_id, read_level, write_level, permissions`
- `relate` ops: `op, source, target, predicate, space_id, read_level, write_level, permissions`

Everything else — `label`, `description`, `span`, `detail`, `confidence`, `born`, `source_url`, arbitrary domain fields — flows through verbatim:

```json
{
  "op": "entity",
  "ref": "@jane",
  "type": "person",
  "label": "Jane Smith",
  "description": "CEO of Acme Corp",
  "born": 1974,
  "location": "Seattle",
  "confidence": 0.92,
  "source_page": 42
}
```

After commit, the created entity's `properties` will contain all six of `label`, `description`, `born`, `location`, `confidence`, and `source_page`.

On `relate` ops, inline properties land on the *relationship entity* — which is how you carry `span`, `detail`, and other provenance metadata that extraction pipelines emit:

```json
{
  "op": "relate",
  "source": "@jane",
  "target": "@acme",
  "predicate": "leads",
  "span": "Jane Smith, CEO of Acme Corp, announced today...",
  "detail": "Appointed CEO in 2019, led two prior restructurings.",
  "confidence": 0.87
}
```

**Do not nest a `properties` object.** The format is deliberately flat. A nested `properties` object would land as a property *called* "properties" rather than expanding into the entity's properties — that is almost never what you want.

### Reserved-key collisions

If a property you want to store happens to share a name with a reserved key (e.g. an entity whose `type` property is semantically distinct from its Arkeon `type`), rename it on the way in — `entity_type`, `native_type`, whatever. The reserved list is small and stable, so collisions are rare.

## Label echo-back

The response `created` array includes a `label` on every entry, extracted from the inline properties. The parser looks at `properties.label` first, then falls back to `properties.name`, then `null`. This gives the calling LLM a human-readable handle to pair with each newly-allocated ULID when composing the next turn.

## Source provenance

Setting `envelope.source.entity_id` to a document ULID causes every *created entity* in the batch to receive an `extracted_from` relationship back to that source document. Edges do not get back-edges (provenance for provenance rapidly becomes noise).

```json
{
  "format": "arke.ops/v1",
  "source": {
    "entity_id": "01JDOC...",
    "extracted_by": { "model": "gpt-4.1", "run_id": "run-123" }
  },
  "ops": [ ... ]
}
```

The `extracted_by` object, if present, is stored as a property on every `extracted_from` edge for audit purposes.

The caller must have read access on `source.entity_id`. If the document isn't visible (wrong ULID, insufficient clearance, RLS-filtered), the whole batch is rejected with `source_not_found` before any writes happen.

This is how extraction pipelines close the loop: every extracted entity is traceable back to the document it came from, and the document is traceable back to the batch via the `extracted_by` metadata. Deleting the source document cleans up the provenance edges without touching the extracted entities themselves (they may be cited from multiple sources).

## Upsert

Setting `defaults.upsert_on: ["label", "type"]` activates deterministic dedup within `/ops`. When an entity op matches an existing entity by `(type, lower(label), space_id)`, the existing entity is **updated** (shallow property merge) instead of duplicated:

```json
{
  "format": "arke.ops/v1",
  "defaults": {
    "space_id": "01SPACE...",
    "upsert_on": ["label", "type"]
  },
  "ops": [
    { "op": "entity", "ref": "@jane", "type": "person", "label": "Jane Smith", "description": "Updated bio" }
  ]
}
```

If "Jane Smith" (person) already exists in that space, her properties are shallow-merged. If not, a new entity is created. The response's `action` field distinguishes: `"created"` or `"updated"`.

**Within-batch dedup** is automatic: two entity ops with the same `(type, lower(label), space_id)` in one request are merged into a single entity. The second op's `@ref` becomes an alias for the first.

**Cross-batch dedup** queries the graph during the transaction and uses optimistic locking (`ver` field). If another writer modified the entity between lookup and write, the transaction fails with `cas_conflict` (409) — retry to pick up the latest version.

Upsert requires `space_id` for matching. Without a space, entities are always created fresh.

## Atomicity

Every `/ops` request runs in a single Postgres transaction. All operations commit together or none do. If any op fails — invalid ref, permission violation, classification ceiling, missing target, RLS denial — the entire batch is rolled back and the caller gets a structured error with:

- `op_index` — which op failed (zero-indexed)
- `code` — a machine-readable category (see error codes below)
- `message` — a human-readable description that names the offending value
- `fix` — a concrete hint for what to change before retrying

Partial success is not an option. If you want "do what you can, skip the failures," split the batch into smaller requests and retry each independently.

### Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `ops_validation_failed` | 422 | One or more ops failed parser validation. `details.errors` is an array of per-op errors with `op_index`, `code`, `field`, `message`, `fix`, `offending_value`. |
| `unresolved_ref` | 422 | A relate op references an `@local` ref that wasn't defined by an earlier entity op |
| `duplicate_ref` | 422 | Two entity ops in the same batch used the same `@ref` |
| `invalid_ref_format` | 422 | A ref is neither `@local` nor a valid ULID |
| `self_reference` | 422 | A relate op's source and target resolve to the same entity |
| `invalid_classification` | 403 | An entity's `read_level` or `write_level` exceeds the actor's clearance |
| `forbidden` | 403 | RLS blocked one or more ops (usually permission or role-related) |
| `source_not_found` | 404 | `source.entity_id` does not exist or is not visible to the actor |
| `target_not_found` | 404 | A bare-ULID source/target on a relate op does not exist or is not visible |
| `missing_required_field` | 400 | An envelope-level required field is missing (e.g. `arke_id` for admin actors) |
| `invalid_request` | 400 | The envelope failed Zod schema validation (malformed shape) |

Every error that references a specific op includes an `op_index` in `details`, so clients can fix the exact offending operation and retry.

## Size limits

- Max 2000 ops per request. Split larger batches into multiple calls.
- Each individual op has no explicit size limit, but the whole request body is subject to the API's global body-size cap.

2000 is a soft bound chosen for transaction duration — larger batches start to hold locks for noticeable intervals. If you routinely need more, chain multiple `/ops` calls, passing the previous response's ULIDs as the source/target values for new relate ops.

## Versioning

The `format` field is `arke.ops/v1` and will stay that way until a breaking change is necessary. When v2 ships:

1. v1 parsing continues to work for a deprecation window
2. New fields added to v1 are additive — unknown-to-parser fields on an op already flow through to properties, so most "new field" cases don't need a version bump
3. Removing or renaming a reserved key requires a version bump

The inline-properties contract is what makes this cheap: anything the LLM wants to encode can go in as a property without waiting for a schema change.

## Extensibility: future op types

The current version ships two op types: `entity` and `relate`. The parser uses a discriminated union on `op`, so adding new types is additive. Candidates reserved conceptually but not implemented:

- `update` — modify an existing entity referenced by ULID
- `content` — attach text/markdown body to an entity created in this batch
- `merge` — merge two entities (reuses the existing merge machinery)
- `tag` — add to a space or group without creating/updating the entity

None of these are on the roadmap. They are listed here so clients don't paint themselves into a corner by, say, using `op: "upsert"` for something else.

## Relationship to other docs

- [ENTITY_REFS.md](./ENTITY_REFS.md) — the `arke:ULID` URI convention that `/ops` extends for relate targets
- [PERMISSIONS.md](./PERMISSIONS.md) — how classification levels and space roles interact with batch operations
- [ERROR_CONTRACT.md](./ERROR_CONTRACT.md) — the general shape of API errors that `/ops` errors conform to
