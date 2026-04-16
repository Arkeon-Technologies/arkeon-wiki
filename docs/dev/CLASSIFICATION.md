# Classification and access control

Arkeon gates reads and writes by a numeric **classification level**. Every
entity carries `read_level` and `write_level`; every actor carries
`max_read_level` and `max_write_level`. Reads and writes are only allowed
when the actor's ceiling is ≥ the entity's floor. This is the read-side
half of the access model — the write-side ACL (owner, editor, admin) is
covered in `PERMISSIONS.md`.

## The 0–4 scale

Classification is a single `int` validated by `ClassificationLevel` in
`packages/arkeon/src/server/lib/schemas.ts`:

| Level | Name | Meaning |
|---|---|---|
| 0 | `PUBLIC` | Readable by anyone, including unauthenticated requests |
| 1 | `INTERNAL` | Default. Readable by any authenticated actor |
| 2 | `TEAM` | Requires TEAM clearance or above |
| 3 | `CONFIDENTIAL` | Requires CONFIDENTIAL clearance or above |
| 4 | `RESTRICTED` | Highest tier; reserved for sensitive material |

The scale is deliberately coarse. There is no level 5 and no way to
register a new one — `.min(0).max(4)` in Zod and matching `CHECK`
constraints in the SQL schema refuse anything outside that range.

## Actor ceilings: `max_read_level` / `max_write_level`

An actor's clearance is stored on the `actors` row as
`max_read_level` and `max_write_level`. These are a **ceiling**, not a
default: an actor with `max_read_level = 3` can read every entity at
levels 0–3 and is denied level 4, regardless of ownership or ACL grants.

Clearances are enforced at two layers:

1. **RLS**. Postgres row-level security reads
   `app.actor_read_level` / `app.actor_write_level` (set per request by
   the API) and compares them to each row's level. This is the
   authoritative gate — bypassing the API layer still hits it.
2. **App layer**. The API additionally checks clearance before any
   mutation so that a too-high write fails with a clean 403 instead of
   an RLS-shaped "row not found".

Actors cannot raise their own ceilings. Only a system admin can grant
higher clearance, and the `actor_update_guard` trigger rejects
self-escalation attempts even for direct SQL.

## Changing an entity's level

Use `PUT /wiki/{id}/level` with a partial body:

```json
{ "read_level": 2, "write_level": 2 }
```

Rules, enforced in `packages/arkeon/src/server/routes/wiki.ts`:

- The caller must be the owner, an editor, or an entity admin.
- New `read_level` cannot exceed the caller's `max_read_level`.
- New `write_level` cannot exceed the caller's `max_write_level`.
- Setting `read_level = 0` (PUBLIC) additionally requires
  `can_publish_public = true` on the actor — normal users cannot
  unilaterally publish.
- Every change writes a `classification_changed` audit record.

## Relationships inherit their endpoints' classification

Classification on entities alone is not enough: if Alice can see two
RESTRICTED people but cannot see the RESTRICTED relationship between
them, she should not be able to infer it exists by querying the graph.
An edge is itself a disclosure, and its visibility has to be at least
as tight as the endpoints it connects.

Arkeon enforces this with a database trigger on `relationship_edges`:

```
relationship.read_level ≥ GREATEST(source.read_level, target.read_level)
```

The trigger `relationship_classification_guard` in
`packages/arkeon/src/schema/015-rls-policies.sql` rejects any insert or update that
violates the rule. The API layer sets the relationship's level to
`GREATEST(src, tgt)` by default so callers don't have to think about it;
the trigger is the safety net against direct SQL or future bugs.

The practical effect: the presence of an edge is never more visible than
its least-visible endpoint. An actor who can't see a node also can't see
any edge touching it, so they can't enumerate its neighbourhood.

## When 0–4 is not enough

This design is intentionally coarse. It gives one knob per direction
(read, write) and one ceiling per actor, and that is the entire surface.
It is enough for most single-org deployments and for the classified-corpus
workloads Arkeon was originally built for.

Teams that need attribute-based access control, per-field masking,
need-to-know compartments, or time-boxed grants should layer those
externally — typically as a policy service in front of the API that
rewrites queries or pre-filters results. Adding that inside the core
schema is a non-goal; the intent is to stay thin enough that external
policy layers can compose on top without fighting a second policy
engine.
