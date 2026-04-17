// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from "@hono/zod-openapi";

import { ApiError } from "./errors";
import type { SqlClient } from "./sql";

export const InlinePermissionGrant = z.object({
  grantee_type: z.enum(["actor"]).describe("Type of grantee"),
  grantee_id: z.string().describe("Actor ULID"),
  role: z.enum(["admin", "editor"]).describe("Permission role to grant"),
});

export type EntityRecord = Record<string, unknown> & {
  id: string;
  kind: string;
  type: string;
  ver: number;
  properties: Record<string, unknown>;
  owner_id: string;
  read_level: number;
  write_level: number;
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

export type PermissionGrant = {
  grantee_type: string;
  grantee_id: string;
  role: string;
};

/**
 * Validates a permission grant object. Throws ApiError on invalid input.
 */
export function validatePermissionGrant(grant: Record<string, unknown>, index?: number): PermissionGrant {
  const prefix = index !== undefined ? `permissions[${index}]: ` : "";
  if (typeof grant.grantee_type !== "string" || grant.grantee_type !== "actor") {
    throw new ApiError(400, "invalid_body", `${prefix}grantee_type must be "actor"`);
  }
  if (typeof grant.grantee_id !== "string" || !grant.grantee_id) {
    throw new ApiError(400, "invalid_body", `${prefix}missing grantee_id`);
  }
  if (typeof grant.role !== "string" || !["admin", "editor"].includes(grant.role)) {
    throw new ApiError(400, "invalid_body", `${prefix}role must be "admin" or "editor"`);
  }
  return grant as unknown as PermissionGrant;
}

/**
 * Returns a QueryDescriptor that upserts an entity permission grant.
 * Suitable for composing into a transaction array.
 */
export function grantEntityPermissionQuery(
  sql: SqlClient,
  entityId: string,
  granteeType: string,
  granteeId: string,
  role: string,
  grantedBy: string,
) {
  return sql.query(
    `INSERT INTO entity_permissions (entity_id, grantee_type, grantee_id, role, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (entity_id, grantee_type, grantee_id)
     DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = NOW()
     RETURNING *`,
    [entityId, granteeType, granteeId, role, grantedBy],
  );
}
