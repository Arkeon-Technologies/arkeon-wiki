# Entity References

Conventions for referencing entities from within properties. No schema changes required — these are patterns on top of plain JSONB that clients and agents should follow.

## Two types of references

### 1. Structured refs (property values)

When a property's value IS a reference to another entity, use an object with an `id` field:

```json
{
  "properties": {
    "label": "Research Report Q3",
    "author": { "id": "01JUSER789", "type": "user", "label": "Alice Chen" },
    "source_document": { "id": "01JFILE456", "type": "file", "label": "Raw Dataset" },
    "related_works": [
      { "id": "01JWORK111", "type": "document", "label": "Prior Report" },
      { "id": "01JWORK222", "label": "Methodology Notes" }
    ]
  }
}
```

**Format:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Entity ID (ULID) |
| `type` | no | Type hint for display/routing |
| `label` | no | Display label (snapshot at time of reference) |

Any object in properties with an `id` field matching the ULID format (`[0-9A-HJKMNP-TV-Z]{26}`) is treated as an entity reference. Refs can appear at any depth — top-level properties, nested objects, or within arrays.

**Detection rule:** An object is an EntityRef if it has an `id` field whose value matches `/^[0-9A-HJKMNP-TV-Z]{26}$/`.

### 2. Inline refs (within text)

When referencing entities within markdown or text content, use the `arke:` URI scheme:

```json
{
  "properties": {
    "label": "Literature Review",
    "content": "Building on [Q3 Analysis](arke:01JDOC789), this report shows continued growth.\n\nSee [Appendix A](arke:01JFILE456) for the raw data."
  }
}
```

**Formats:**

```markdown
<!-- Markdown link (preferred — includes display label) -->
[Display Label](arke:01JENTITYID1234567890ABCD)

<!-- Raw reference (when no label is needed) -->
See arke:01JENTITYID1234567890ABCD for details.
```

**Parsing regex:**

```
# Extract all referenced IDs
arke:([0-9A-HJKMNP-TV-Z]{26})

# Extract markdown links with labels
\[([^\]]+)\]\(arke:([0-9A-HJKMNP-TV-Z]{26})\)
```

## Querying references

### "What does this entity reference?"

Extract refs client-side from the entity's properties. Walk the JSONB tree for structured refs, regex-scan text fields for inline refs.

### "What references this entity?"

Use a LIKE pattern on the properties text representation:

```sql
SELECT * FROM entities
WHERE properties::text LIKE '%01JTARGET123%';
```

This catches both structured refs (the `id` value appears in the JSON text) and inline refs (the `arke:` URI contains the ID). Sufficient for most workloads.

For full-text search at scale, use Meilisearch via the `GET /search` endpoint.

## Refs vs. relationships

These are separate concepts:

| | Refs | Relationships |
|---|------|---------------|
| **What** | Lightweight mentions embedded in properties | First-class versioned graph edges |
| **Storage** | Part of entity JSONB | Separate `relationship_edges` table + relationship entity |
| **Permissions** | Inherited from the containing entity | Independent (own owner, own access grants) |
| **Versioning** | Versioned with the containing entity | Independently versioned |
| **Metadata** | None beyond type/label hints | Full properties (source_text, context, weight, etc.) |
| **Use case** | "This report was written by Alice" | "This paper formally cites that paper" |
| **Creation** | Set a property value | `POST /wiki` (relationships are created as part of the wiki pipeline) |

**Rule of thumb:** If the connection is part of the entity's own data (author, source, parent document), use a ref. If the connection is an assertion that deserves its own identity, permissions, or metadata, use a relationship.

## Client responsibilities

### Rendering

- Detect `arke:` URIs in rendered text and convert to clickable links
- Resolve referenced entity IDs to fetch labels/types for display
- Handle missing entities gracefully (entity may have been deleted)
- Structured ref `label` fields are snapshots — they may be stale

### Creating

- When setting a property to an entity reference, include at minimum `{ id }`. Adding `type` and `label` helps with display without requiring a lookup.
- When writing markdown content with entity mentions, use the `[Label](arke:ID)` format for accessibility.
- Inline refs do NOT require permission on the referenced entity (same as relationships — referencing is an assertion by the author).
