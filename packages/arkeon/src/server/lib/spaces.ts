// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors";
import { withTransaction, type SqlClient } from "./sql";
import { setActorContext } from "./actor-context";
import type { Actor } from "../types";

export type SpaceRecord = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  read_level: number;
  write_level: number;
  status: string;
  entity_count: number;
  last_activity_at: string | null;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/**
 * Fetch a single space visible to the given actor (or null for anonymous).
 *
 * MUST be used instead of a bare `SELECT * FROM spaces WHERE id = ...`:
 * the `spaces_select` RLS policy in `packages/schema/015-rls-policies.sql`
 * depends on `current_actor_read_level()`, which is sourced from the
 * `app.actor_read_level` session variable. That variable is set via
 * `SET LOCAL` inside transactions — a query made on a pooled connection
 * without an active transaction sees no session context at all, which
 * means `current_actor_read_level()` falls back to `-1` and only
 * `read_level = 0` rows are visible.
 *
 * Wrapping the SELECT in `withTransaction` + `setActorContext` makes the
 * read honor the actor's real clearance.
 *
 * Returns the space or null if not visible / not found. Callers are
 * responsible for deciding whether null → 404 or 403.
 */
export async function fetchSpaceForActor(
  actor: Actor | null,
  spaceId: string,
): Promise<SpaceRecord | null> {
  return withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) {
      await q;
    }
    const [space] = await tx`SELECT * FROM spaces WHERE id = ${spaceId} LIMIT 1`;
    return (space as SpaceRecord | undefined) ?? null;
  });
}

/**
 * Checks whether the actor has the required role on a space (or is owner/admin).
 * Returns the space record or throws.
 *
 * Runs reads inside a transaction with RLS session context applied —
 * see `fetchSpaceForActor` above for why the bare-SELECT form is broken.
 *
 * The `sql` parameter is retained for call-site ergonomics (callers
 * already have a client in hand) but ignored — the helper manages its
 * own transaction.
 */
export async function requireSpaceRole(
  _sql: SqlClient,
  actor: Actor,
  spaceId: string,
  requiredRole: "viewer" | "contributor" | "editor" | "admin" | "owner",
): Promise<SpaceRecord> {
  return withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) {
      await q;
    }

    const [spaceRow] = await tx`SELECT * FROM spaces WHERE id = ${spaceId} LIMIT 1`;
    if (!spaceRow) {
      throw new ApiError(404, "not_found", "Space not found");
    }
    const s = spaceRow as SpaceRecord;

    // Defense-in-depth read_level check. RLS has already filtered the
    // SELECT above, but admins bypass RLS via their session flag — this
    // still gives a clear 403 path at the application layer.
    if (s.read_level > actor.maxReadLevel && !actor.isAdmin) {
      throw new ApiError(403, "forbidden", "Insufficient read level");
    }

    if (requiredRole === "viewer") return s;
    if (actor.isAdmin) return s;
    if (s.owner_id === actor.id) return s;

    const roleHierarchy = ["viewer", "contributor", "editor", "admin"];
    const requiredIdx = roleHierarchy.indexOf(requiredRole);

    const [perm] = await tx`
      SELECT role FROM space_permissions
      WHERE space_id = ${spaceId} AND grantee_id = ${actor.id}
      LIMIT 1
    `;

    if (!perm) {
      throw new ApiError(403, "forbidden",
        `You have no role on this space. Required: ${requiredRole}. Grant access via POST /spaces/${spaceId}/permissions`);
    }

    const grantedIdx = roleHierarchy.indexOf(perm.role as string);
    if (grantedIdx < requiredIdx) {
      throw new ApiError(403, "forbidden",
        `Your role '${perm.role}' is insufficient, need '${requiredRole}'. Upgrade via POST /spaces/${spaceId}/permissions`);
    }

    return s;
  });
}

/**
 * Resolve the "default" space for an actor when a route accepts space_id as
 * optional. Returns the single space the actor can contribute to (owned,
 * admin-on-instance with exactly one space, or exactly one contributor-plus
 * permission). Throws 400 with a helpful message if none or ambiguous.
 *
 * Used by POST /wiki (and anywhere else that wants "pick my space for me"
 * ergonomics for single-space instances).
 */
export async function resolveDefaultSpace(actor: Actor): Promise<string> {
  return withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) {
      await q;
    }

    // Pull up to two candidate spaces. We only care whether there's exactly
    // one; more than one is ambiguous regardless of order.
    const rows = actor.isAdmin
      ? await tx`
          SELECT id FROM spaces
          WHERE status = 'active'
          ORDER BY created_at ASC
          LIMIT 2
        `
      : await tx`
          SELECT DISTINCT s.id
          FROM spaces s
          LEFT JOIN space_permissions sp
            ON sp.space_id = s.id AND sp.grantee_id = ${actor.id}
          WHERE s.status = 'active'
            AND (
              s.owner_id = ${actor.id}
              OR sp.role IN ('contributor', 'editor', 'admin')
            )
          ORDER BY s.id ASC
          LIMIT 2
        `;

    if (rows.length === 0) {
      throw new ApiError(
        400,
        "no_default_space",
        "No space to default to. Create one with POST /spaces, or pass space_id explicitly.",
      );
    }
    if (rows.length > 1) {
      throw new ApiError(
        400,
        "ambiguous_default_space",
        "Multiple spaces are contributable. Pass space_id explicitly; list candidates with GET /spaces.",
      );
    }
    return String(rows[0]!.id);
  });
}
