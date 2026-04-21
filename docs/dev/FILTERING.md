# Filtering & Text Search

Unified query system for listing endpoints. Search (`GET /search`) uses Meilisearch with a different parameter model.

## Filter Syntax

```text
filter=path<operator>value[,path<operator>value,...]
```

Expressions are comma-separated and ANDed.

### Operators

| Op | Meaning | Example |
|----|---------|---------|
| `:` | equals | `properties.subject_type:book` |
| `!:` | not equals | `kind!:relationship` |
| `>` | greater than | `ver>3` |
| `>=` | gte | `created_at>=2026-01-01T00:00:00Z` |
| `<` | less than | `updated_at<2026-06-01T00:00:00Z` |
| `<=` | lte | `year<=2024` |
| `?` | exists / not null | `label?` |
| `!?` | missing / null | `description!?` |

Text columns support `:` and `!:` only. Numeric and timestamp columns support range operators.

### Property Paths

Non-whitelisted paths drill into `properties` JSONB with dot notation:

```text
filter=metadata.source:arxiv
filter=metadata.source.year>2020
```

Numeric comparisons on property paths cast the extracted value to `numeric`.

## Implicit Route Filters

- `GET /search` defaults to `kind!:relationship` unless caller specifies `kind`
- `GET /entities` applies RLS-based visibility filtering

## Pagination

Listing endpoints use cursor-based pagination (timestamp + ID tuple, base64-encoded). `GET /search` uses offset-based pagination (`offset` + `limit`) with `estimatedTotalHits`.

## Performance Notes

Filters are parameterized. Route-level scope filters narrow the candidate set early. Add targeted indexes based on observed access patterns rather than pre-indexing every property path.
