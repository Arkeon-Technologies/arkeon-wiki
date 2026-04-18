// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors";
import { withTransaction } from "./sql";
import { setActorContext } from "./actor-context";
import type { Actor } from "../types";

export type SpaceRecord = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
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
 * Wraps the SELECT in `withTransaction` + `setActorContext` so RLS
 * session variables are set correctly. Returns the space or null if
 * not found. All authenticated actors have full access.
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
 * Resolve the "default" space for an actor when a route accepts space_id as
 * optional. Returns the single active space if exactly one exists. Throws
 * 400 with a helpful message if none or ambiguous.
 *
 * Used by POST /wiki (and anywhere else that wants "pick my space for me"
 * ergonomics for single-space instances).
 */
export async function resolveDefaultSpace(actor: Actor): Promise<string> {
  return withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) {
      await q;
    }

    // All authenticated actors have full access — just find active spaces.
    // Pull up to two; we only care whether there's exactly one.
    const rows = await tx`
      SELECT id FROM spaces
      WHERE status = 'active'
      ORDER BY created_at ASC
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
