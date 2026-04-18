// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors";
import type { SqlClient } from "./sql";

export type EntityRecord = Record<string, unknown> & {
  id: string;
  kind: string;
  type: string;
  ver: number;
  properties: Record<string, unknown>;
  owner_id: string;
  edited_by: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export function assertBodyObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_body", `Invalid ${field}`);
  }

  return value as Record<string, unknown>;
}

/**
 * Returns a QueryDescriptor that inserts an entity into a space.
 * Suitable for composing into a transaction array.
 */
export function addEntityToSpaceQuery(
  sql: SqlClient,
  spaceId: string,
  entityId: string,
  actorId: string,
  now: string,
) {
  return sql.query(
    `INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
     VALUES ($1, $2, $3, $4::timestamptz)
     ON CONFLICT (space_id, entity_id) DO NOTHING
     RETURNING space_id, entity_id, added_by, added_at`,
    [spaceId, entityId, actorId, now],
  );
}

