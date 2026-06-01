# Error Contract

Consistent JSON error shape for all API endpoints.

## Shape

```json
{
  "error": {
    "code": "not_found",
    "message": "artifact not found",
    "details": {},
    "request_id": "..."
  }
}
```

- `code`: stable machine-readable identifier
- `message`: short human-readable summary
- `details`: optional structured context
- `request_id`: trace identifier from `X-Request-ID` header or auto-generated

## Rules

- Every non-2xx response returns this shape
- Unexpected exceptions map to `internal_error`
- SQLite constraint violations are mapped to meaningful codes (`conflict`, `invalid_reference`, `missing_field`, `validation_error`) in `src/server/lib/db-errors.ts`

## Common codes

| Status | Code | When |
|--------|------|------|
| `400` | `validation_error` | Invalid request body or constraint violation |
| `400` | `invalid_reference` | FK references a nonexistent record |
| `404` | `not_found` | Artifact not found |
| `409` | `conflict` | Unique constraint violation |
| `500` | `internal_error` | Unexpected error |
| `503` | `not_ready` | Watcher not started / database unavailable |
