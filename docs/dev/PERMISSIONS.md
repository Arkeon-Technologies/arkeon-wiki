# Permissions

Two-layer access control: classification levels for reads, ACL grants for writes.

## Classification Levels (Read/Write Access)

Entities have `read_level` and `write_level` (integers, default 1). Actors have matching levels on their record. An actor can see an entity if `actor.read_level >= entity.read_level`. Same logic for writes.

Enforced via RLS with per-request context variables:
- `app.actor_id`, `app.actor_read_level`, `app.actor_write_level`, `app.actor_is_admin`

## Entity Permissions (Write ACL)

Two roles plus ownership:

| Role | Edit content | Manage permissions | Transfer/delete |
|------|-------------|-------------------|-----------------|
| **Owner** | Yes | Yes | Yes |
| **Admin** | Yes | Yes | No |
| **Editor** | Yes | No | No |

Grants target individual actors via `entity_permissions` table (see `005-entity-permissions.sql`).

There is no 'viewer' role — read access is governed entirely by classification levels. There is no 'contributor' role on entities — contribution is a space-level concept.

## Space Permissions

Spaces have their own layer with four roles: **admin**, **editor**, **contributor**, **viewer**. Space membership is tracked in `space_permissions` (separate from entity permissions). Space entities are linked via the `space_entities` join table.

## Defaults

| Field | Default |
|-------|---------|
| `owner_id` | Creating actor |
| `read_level` | 1 |
| `write_level` | 1 |

## Ownership Transfer

1. New owner is set (`owner_id` updated)
2. `ownership_transferred` audit record written
3. Previous owner loses all access unless they have a separate permission grant (no automatic admin grant)
