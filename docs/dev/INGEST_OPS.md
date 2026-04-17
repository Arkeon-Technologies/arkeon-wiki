# Ingest Ops

`POST /ops` is a compatibility bulk-ingestion endpoint for structured graph
writes. It is useful for seed data, repo extraction output, and cross-space
connection batches where representing every edge as authored wiki prose would be
awkward.

Wiki pages remain the primary authoring path. Use `POST /wiki` for narrative
content with typed links; use `POST /ops` when you already have structured
entities and relationships.

## Envelope

```json
{
  "format": "arke.ops/v1",
  "defaults": {
    "space_id": "01...",
    "read_level": 1,
    "write_level": 1
  },
  "source": {
    "entity_id": "01..."
  },
  "ops": [
    {
      "op": "entity",
      "ref": "@augustine",
      "type": "person",
      "label": "Augustine of Hippo",
      "description": "Early Christian theologian"
    },
    {
      "op": "relate",
      "source": "@augustine",
      "target": "01...",
      "predicate": "references",
      "detail": "Mentioned in the source document"
    }
  ]
}
```

Supported operations:

- `entity`: creates a graph entity. All fields other than `op`, `ref`, `type`,
  `read_level`, and `write_level` are stored in `properties`. The entity's
  top-level `type` is preserved for compatibility, and `properties.subject_type`
  is also set to the same value for wiki-first filters.
- `relate`: creates a relationship entity plus a `relationship_edges` row.
  `source` and `target` may be bare ULIDs or earlier `@ref` values from the same
  envelope.

`defaults.space_id` adds every created entity and relationship to that space and
requires contributor access. Omit it for cross-space relationship batches that
should not belong to one space.

`source.entity_id` creates `extracted_from` relationships from every created
entity and relationship to the source entity.

## Dry Run

Use `?dry_run=true` to validate the envelope and receive planned IDs without
writing:

```bash
curl -X POST "$ARKE_API/ops?dry_run=true" \
  -H "Authorization: ApiKey $ARKE_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @ops.json
```

The endpoint currently accepts up to 1000 ops per request.
