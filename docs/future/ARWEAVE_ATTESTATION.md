# Arweave Attestation (Future Enhancement)

On-demand snapshots of entity state, permanently stored on Arweave for third-party verification.

## How it works

Archiving is an explicit action, not automatic. A user (or agent) calls the archive endpoint, which:

1. Queries the full entity state at that moment
2. Computes a CID from the snapshot
3. Uploads the snapshot to Arweave
4. Logs an `entity_archived` audit record with the CID and Arweave TX ID

No queue, no background workers. Volume is low enough to handle synchronously.

## Endpoints

```
POST /wiki/:id/archive
POST /spaces/:id/archive
```

Auth: owner or admin of the entity (or anyone authenticated for public entities).

Response:
```json
{
  "cid": "bafy...",
  "arweave_tx": "abc123...",
  "ver": 7,
  "snapshot_at": "2026-03-21T15:30:00Z"
}
```

## What gets snapshotted

The snapshot captures everything needed to reconstruct the entity's state:

1. **Entity core** — all columns from entities table
2. **Outbound relationships** — relationships where this entity is the source
3. **Inbound relationships** — relationships where this entity is the target
4. **Permission grants** — all entity_permissions rows

## Snapshot document

Canonical JSON structure that gets CID'd and uploaded:

```json
{
  "schema": "arke-snapshot-v1",
  "entity": { "id": "...", "kind": "entity", "type": "book", "ver": 7, "..." : "..." },
  "relationships_out": [{ "relationship_id": "...", "target_id": "...", "predicate": "cites", "properties": {} }],
  "relationships_in": [{ "relationship_id": "...", "source_id": "...", "predicate": "references", "properties": {} }],
  "permissions": [{ "grantee_type": "actor", "grantee_id": "...", "role": "editor", "granted_at": "..." }],
  "snapshot_at": "2026-03-21T15:30:00Z",
  "snapshot_by": "01ACTOR..."
}
```

Fields are sorted deterministically before CID computation so the same state always produces the same CID.

## Verification

Anyone can verify an archived entity:

1. Get the archive activity entry (CID + Arweave TX)
2. Fetch the snapshot from Arweave using the TX ID
3. Recompute the CID from the fetched document
4. Compare — if they match, the snapshot is authentic

## Why not automatic?

- Most entities don't need permanent attestation
- Arweave uploads cost money (AR tokens)
- Automatic per-version attestation generates noise
- Users/agents choose what's worth archiving

## Future considerations

- Encrypted archiving for private entities
- Batch archiving for spaces (all entities in a space)
- `entity_archived` audit record for tracking archive history
