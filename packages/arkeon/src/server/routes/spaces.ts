// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { backgroundTask } from "../lib/background";
import { ApiError } from "../lib/errors";
import {
  requireActor,
  parseJsonBody,
  parseLimit,
  parseCursorParam,
} from "../lib/http";
import { indexEntityById } from "../lib/meilisearch";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { encodeCursor } from "../lib/cursor";
import {
  ClassificationLevel,
  DateTimeSchema,
  EntityIdParam,
  EntitySchema,
  JsonObjectSchema,
  SpaceSchema,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";
import { addEntityToSpaceQuery } from "../lib/entities";
import { fetchSpaceForActor, requireSpaceRole, type SpaceRecord } from "../lib/spaces";

type SpacePermissionRecord = {
  space_id: string;
  grantee_id: string;
  role: string;
  granted_at: string;
};

const SpacePermissionSchema = z.object({
  space_id: EntityIdParam,
  grantee_id: EntityIdParam,
  role: z.enum(["viewer", "contributor", "editor", "admin"]),
  granted_at: DateTimeSchema,
});

const createSpaceRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createSpace",
  tags: ["Spaces"],
  summary: "Create a new space",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /spaces/{id}", "GET /spaces"],
  "x-arke-rules": ["You become the owner of the space"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).describe("Space name"),
          description: z.string().nullable().optional().describe("Space description"),
          read_level: ClassificationLevel.optional().describe("Read classification level (0-4)"),
          write_level: ClassificationLevel.optional().describe("Write classification level (0-4)"),
          properties: JsonObjectSchema.optional().describe("Arbitrary properties"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Space created",
      content: jsonContent(z.object({ space: SpaceSchema })),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listSpacesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listSpaces",
  tags: ["Spaces"],
  summary: "List spaces (paginated, RLS filters by read_level)",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /spaces", "GET /spaces/{id}"],
  "x-arke-rules": ["Results filtered by your classification clearance"],
  request: {
    query: paginationQuerySchema(50, 200).extend({
      q: queryParam("q", z.string().optional(), "Search by name"),
    }),
  },
  responses: {
    200: {
      description: "Space listing",
      content: jsonContent(cursorResponseSchema("spaces", SpaceSchema)),
    },
    ...errorResponses([400]),
  },
});

const getSpaceRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getSpace",
  tags: ["Spaces"],
  summary: "Fetch a single space by ID",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /spaces/{id}", "GET /spaces/{id}/entities"],
  "x-arke-rules": ["Requires read_level clearance >= space's read_level"],
  request: {
    params: entityIdParams("Space ULID"),
  },
  responses: {
    200: {
      description: "Space details",
      content: jsonContent(z.object({ space: SpaceSchema })),
    },
    ...errorResponses([403, 404]),
  },
});

const updateSpaceRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateSpace",
  tags: ["Spaces"],
  summary: "Update a space (RLS: owner/editor/admin)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /spaces/{id}"],
  "x-arke-rules": ["Requires space role: editor or above", "Owner and system admins bypass role checks"],
  request: {
    params: entityIdParams("Space ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).optional().describe("New name"),
          description: z.string().nullable().optional().describe("New description"),
          read_level: ClassificationLevel.optional().describe("New read level"),
          write_level: ClassificationLevel.optional().describe("New write level"),
          properties: JsonObjectSchema.optional().describe("New properties"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Space updated",
      content: jsonContent(z.object({ space: SpaceSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const deleteSpaceRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteSpace",
  tags: ["Spaces"],
  summary: "Soft-delete a space (set status=deleted, RLS: owner/admin)",
  "x-arke-auth": "required",
  "x-arke-rules": ["Only the space owner or a system admin may delete"],
  request: {
    params: entityIdParams("Space ULID"),
  },
  responses: {
    200: {
      description: "Space soft-deleted",
      content: jsonContent(z.object({ space: SpaceSchema })),
    },
    ...errorResponses([401, 403, 404]),
  },
});

const listSpaceEntitiesRoute = createRoute({
  method: "get",
  path: "/{id}/entities",
  operationId: "listSpaceEntities",
  tags: ["Spaces"],
  summary: "List entities in a space",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /spaces/{id}/entities", "GET /spaces/{id}"],
  "x-arke-rules": ["Requires read_level clearance >= space's read_level", "Entity results further filtered by your classification clearance"],
  request: {
    params: entityIdParams("Space ULID"),
    query: paginationQuerySchema(50, 200),
  },
  responses: {
    200: {
      description: "Entities in the space",
      content: jsonContent(cursorResponseSchema("entities", EntitySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const addSpaceEntityRoute = createRoute({
  method: "post",
  path: "/{id}/entities",
  operationId: "addSpaceEntity",
  tags: ["Spaces"],
  summary: "Add an entity to a space (RLS: contributor+)",
  "x-arke-auth": "required",
  "x-arke-related": ["DELETE /spaces/{id}/entities/{entityId}"],
  "x-arke-rules": ["Requires space role: contributor or above"],
  request: {
    params: entityIdParams("Space ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          entity_id: EntityIdParam.describe("Entity ULID to add"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Entity added to space",
      content: jsonContent(
        z.object({
          space_id: EntityIdParam,
          entity_id: EntityIdParam,
          added_by: EntityIdParam,
          added_at: DateTimeSchema,
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const removeSpaceEntityRoute = createRoute({
  method: "delete",
  path: "/{id}/entities/{entityId}",
  operationId: "removeSpaceEntity",
  tags: ["Spaces"],
  summary: "Remove an entity from a space (RLS: editor+ or added_by)",
  "x-arke-auth": "required",
  "x-arke-rules": ["You can remove entities you added yourself", "Otherwise requires space role: editor or above"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Space ULID"),
      entityId: pathParam("entityId", EntityIdParam, "Entity ULID"),
    }),
  },
  responses: {
    204: {
      description: "Entity removed from space",
    },
    ...errorResponses([401, 403, 404]),
  },
});

const SpaceGrantSchema = z.object({
  grantee_type: z.enum(["actor", "group"]).default("actor").describe("Grantee type"),
  grantee_id: z.string().describe("Actor or group ID"),
  role: z.enum(["contributor", "editor", "admin"]).describe("Role to grant"),
});

const grantSpacePermissionRoute = createRoute({
  method: "post",
  path: "/{id}/permissions",
  operationId: "grantSpacePermission",
  tags: ["Spaces"],
  summary: "Grant role(s) on a space. Accepts a single grant or a bulk grants array (RLS: owner/admin)",
  "x-arke-auth": "required",
  "x-arke-related": ["DELETE /spaces/{id}/permissions/{granteeId}", "GET /spaces/{id}/permissions"],
  "x-arke-rules": ["Only the space owner or a system admin may grant permissions", "Valid roles: contributor, editor, admin", "Maximum 100 grants per request"],
  request: {
    params: entityIdParams("Space ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.union([
          SpaceGrantSchema,
          z.object({
            grants: z.array(SpaceGrantSchema).min(1).max(100)
              .describe("Array of permission grants (max 100)"),
          }),
        ]),
      ),
    },
  },
  responses: {
    201: {
      description: "Permission(s) granted",
      content: jsonContent(z.union([
        z.object({ permission: SpacePermissionSchema }),
        z.object({ permissions: z.array(SpacePermissionSchema) }),
      ])),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const revokeSpacePermissionRoute = createRoute({
  method: "delete",
  path: "/{id}/permissions/{granteeId}",
  operationId: "revokeSpacePermission",
  tags: ["Spaces"],
  summary: "Revoke a role on a space (RLS: owner/admin)",
  "x-arke-auth": "required",
  "x-arke-rules": ["Only the space owner or a system admin may revoke permissions"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Space ULID"),
      granteeId: pathParam("granteeId", EntityIdParam, "Grantee actor/group ULID"),
    }),
  },
  responses: {
    204: {
      description: "Permission revoked",
    },
    ...errorResponses([401, 403, 404]),
  },
});

const listSpacePermissionsRoute = createRoute({
  method: "get",
  path: "/{id}/permissions",
  operationId: "listSpacePermissions",
  tags: ["Spaces"],
  summary: "List permissions on a space",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /spaces/{id}/permissions"],
  "x-arke-rules": ["Requires read_level clearance >= space's read_level"],
  request: {
    params: entityIdParams("Space ULID"),
  },
  responses: {
    200: {
      description: "Space permissions",
      content: jsonContent(
        z.object({
          permissions: z.array(SpacePermissionSchema),
        }),
      ),
    },
    ...errorResponses([403, 404]),
  },
});

// -- Space Entity Access (cascading permissions to contained entities) --------

type SpaceEntityAccessRecord = {
  space_id: string;
  grantee_type: string;
  grantee_id: string;
  role: string;
  granted_by: string;
  granted_at: string;
};

const SpaceEntityAccessSchema = z.object({
  space_id: EntityIdParam,
  grantee_type: z.enum(["actor", "group"]),
  grantee_id: EntityIdParam,
  role: z.enum(["editor", "admin"]),
  granted_by: EntityIdParam,
  granted_at: DateTimeSchema,
});

const SpaceEntityAccessGrantSchema = z.object({
  grantee_type: z.enum(["actor", "group"]).default("actor").describe("Grantee type"),
  grantee_id: z.string().describe("Actor or group ID"),
  role: z.enum(["editor", "admin"]).describe("Entity role to grant"),
});

const grantSpaceEntityAccessRoute = createRoute({
  method: "post",
  path: "/{id}/entity-access",
  operationId: "grantSpaceEntityAccess",
  tags: ["Spaces"],
  summary: "Grant entity-level access to all entities in a space. Accepts a single grant or bulk grants array",
  "x-arke-auth": "required",
  "x-arke-related": ["DELETE /spaces/{id}/entity-access/{granteeId}", "GET /spaces/{id}/entity-access"],
  "x-arke-rules": [
    "Requires space role: admin",
    "Valid roles: editor, admin",
    "Grantees can edit/admin any entity currently in the space",
    "Removing an entity from the space revokes this access",
    "Maximum 100 grants per request",
  ],
  request: {
    params: entityIdParams("Space ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.union([
          SpaceEntityAccessGrantSchema,
          z.object({
            grants: z.array(SpaceEntityAccessGrantSchema).min(1).max(100)
              .describe("Array of entity-access grants (max 100)"),
          }),
        ]),
      ),
    },
  },
  responses: {
    201: {
      description: "Entity access granted",
      content: jsonContent(z.union([
        z.object({ grant: SpaceEntityAccessSchema }),
        z.object({ grants: z.array(SpaceEntityAccessSchema) }),
      ])),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const revokeSpaceEntityAccessRoute = createRoute({
  method: "delete",
  path: "/{id}/entity-access/{granteeId}",
  operationId: "revokeSpaceEntityAccess",
  tags: ["Spaces"],
  summary: "Revoke entity-level access on a space",
  "x-arke-auth": "required",
  "x-arke-rules": ["Requires space role: admin"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Space ULID"),
      granteeId: pathParam("granteeId", EntityIdParam, "Grantee actor/group ULID"),
    }),
  },
  responses: {
    204: {
      description: "Entity access revoked",
    },
    ...errorResponses([401, 403, 404]),
  },
});

const listSpaceEntityAccessRoute = createRoute({
  method: "get",
  path: "/{id}/entity-access",
  operationId: "listSpaceEntityAccess",
  tags: ["Spaces"],
  summary: "List entity-access grants on a space",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /spaces/{id}/entity-access"],
  "x-arke-rules": ["Requires read_level clearance >= space's read_level"],
  request: {
    params: entityIdParams("Space ULID"),
  },
  responses: {
    200: {
      description: "Entity-access grants",
      content: jsonContent(
        z.object({
          grants: z.array(SpaceEntityAccessSchema),
        }),
      ),
    },
    ...errorResponses([403, 404]),
  },
});

export const spacesRouter = createRouter();

spacesRouter.openapi(createSpaceRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  if (typeof body.name !== "string" || body.name.length === 0) {
    throw new ApiError(400, "missing_required_field", "Missing name");
  }
  const id = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql();
  const description = typeof body.description === "string" ? body.description : null;
  const readLevel = typeof body.read_level === "number" ? body.read_level : 1;
  const writeLevel = typeof body.write_level === "number" ? body.write_level : 1;
  const properties = body.properties && typeof body.properties === "object" ? body.properties : {};

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        INSERT INTO spaces (id, name, description, owner_id, read_level, write_level, status, entity_count, properties, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, $7::jsonb, $8::timestamptz, $8::timestamptz)
        RETURNING *
      `,
      [id, body.name, description, actor.id, readLevel, writeLevel, JSON.stringify(properties), now],
    ),
  ]);

  const space = (results.at(-1) as SpaceRecord[])[0];
  if (!space) {
    throw new ApiError(500, "internal_error", "Failed to create space");
  }

  return c.json({ space }, 201);
});

spacesRouter.openapi(listSpacesRoute, async (c) => {
  const sql = createSql();
  const actorCtx = c.get("actor") ?? null;
  const isAdmin = actorCtx?.isAdmin ?? false;
  const actorReadLevel = actorCtx?.maxReadLevel ?? -1;
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const q = c.req.query("q");

  // Wrap in a transaction with RLS session context so the read honors the
  // actor's clearance — a bare `SELECT ... FROM spaces` runs without any
  // `app.actor_*` session variables and `spaces_select` falls back to the
  // `read_level = 0` branch only. See `lib/spaces.ts#fetchSpaceForActor`.
  const txResults = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT *
        FROM spaces
        WHERE status != 'deleted'
          AND ($1::boolean OR read_level <= $2)
          AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
          AND ($4::timestamptz IS NULL OR created_at < $4::timestamptz)
        ORDER BY created_at DESC
        LIMIT $5
      `,
      [isAdmin, actorReadLevel, q ?? null, cursor?.t ?? null, limit + 1],
    ),
  ]);
  const rows = txResults[txResults.length - 1];

  const spaces = (rows as SpaceRecord[]).slice(0, limit);
  const next = (rows as SpaceRecord[]).length > limit ? spaces[spaces.length - 1] : null;

  return c.json({
    spaces,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.id }) : null,
  }, 200);
});

spacesRouter.openapi(getSpaceRoute, async (c) => {
  const spaceId = c.req.param("id");
  const actor = c.get("actor") ?? null;

  const space = await fetchSpaceForActor(actor, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  return c.json({ space }, 200);
});

spacesRouter.openapi(updateSpaceRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  await requireSpaceRole(sql, actor, spaceId, "editor");

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (typeof body.name === "string") {
    sets.push(`name = $${paramIdx++}`);
    params.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push(`description = $${paramIdx++}`);
    params.push(typeof body.description === "string" ? body.description : null);
  }
  if (typeof body.read_level === "number") {
    sets.push(`read_level = $${paramIdx++}`);
    params.push(body.read_level);
  }
  if (typeof body.write_level === "number") {
    sets.push(`write_level = $${paramIdx++}`);
    params.push(body.write_level);
  }
  if (body.properties && typeof body.properties === "object") {
    sets.push(`properties = $${paramIdx++}::jsonb`);
    params.push(JSON.stringify(body.properties));
  }

  if (sets.length === 0) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  sets.push(`updated_at = $${paramIdx++}::timestamptz`);
  params.push(now);

  const idParamIdx = paramIdx++;
  params.push(spaceId);

  // RLS on spaces_update reads session context — the UPDATE must run
  // inside a transaction with setActorContext or it will silently match
  // zero rows (even for admins / owners).
  const updateResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE spaces
        SET ${sets.join(", ")}
        WHERE id = $${idParamIdx}
        RETURNING *
      `,
      params,
    ),
  ]);
  const updated = (updateResults[updateResults.length - 1] as SpaceRecord[])[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  return c.json({ space: updated }, 200);
});

spacesRouter.openapi(deleteSpaceRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const sql = createSql();
  const now = new Date().toISOString();

  const space = await requireSpaceRole(sql, actor, spaceId, "admin");
  // Only owner or admin can soft-delete
  if (space.owner_id !== actor.id && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Only owner or admin can delete");
  }

  // spaces_delete RLS needs session context; bare UPDATE would fail silently.
  const deleteResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE spaces
        SET status = 'deleted', updated_at = $1::timestamptz
        WHERE id = $2
        RETURNING *
      `,
      [now, spaceId],
    ),
  ]);
  const deleted = (deleteResults[deleteResults.length - 1] as SpaceRecord[])[0];
  if (!deleted) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  return c.json({ space: deleted }, 200);
});

spacesRouter.openapi(listSpaceEntitiesRoute, async (c) => {
  const sql = createSql();
  const spaceId = c.req.param("id");
  const actorCtx = c.get("actor") ?? null;
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);

  // Verify space exists and is readable
  const space = await fetchSpaceForActor(actorCtx, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const results = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT e.*
        FROM space_entities se
        JOIN entities e ON e.id = se.entity_id
        WHERE se.space_id = $1
          AND ($2::timestamptz IS NULL OR e.created_at < $2::timestamptz)
        ORDER BY e.created_at DESC
        LIMIT $3
      `,
      [spaceId, cursor?.t ?? null, limit + 1],
    ),
  ]);

  const rows = results.at(-1) as Array<Record<string, unknown>>;
  const entities = rows.slice(0, limit);
  const next = rows.length > limit ? entities[entities.length - 1] : null;

  return c.json({
    entities,
    cursor: next ? encodeCursor({ t: next.created_at as string, i: next.id as string }) : null,
  }, 200);
});

spacesRouter.openapi(addSpaceEntityRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  if (typeof body.entity_id !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing entity_id");
  }

  await requireSpaceRole(sql, actor, spaceId, "contributor");

  const now = new Date().toISOString();
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    addEntityToSpaceQuery(sql, spaceId, String(body.entity_id), actor.id, now),
  ]);

  const added = (results[results.length - 1] as Array<Record<string, unknown>>)[0];
  if (!added) {
    return c.json({ space_id: spaceId, entity_id: body.entity_id }, 201);
  }

  backgroundTask(indexEntityById(String(body.entity_id)));

  return c.json(added, 201);
});

spacesRouter.openapi(removeSpaceEntityRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const entityId = c.req.param("entityId");
  const sql = createSql();

  // Check if the actor is the one who added it, or has editor+ role.
  // space_entities RLS requires actor context — bare SELECT would never
  // return rows for level-1+ spaces.
  const entryResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT added_by FROM space_entities
      WHERE space_id = ${spaceId} AND entity_id = ${entityId}
      LIMIT 1
    `,
  ]);
  const entry = (entryResults[entryResults.length - 1] as Array<{ added_by: string }>)[0];

  if (!entry) {
    const space = await fetchSpaceForActor(actor, spaceId);
    if (!space) {
      throw new ApiError(404, "not_found", "Space not found");
    }
    throw new ApiError(404, "not_found", "Entity not in space");
  }

  if (entry.added_by !== actor.id) {
    // Need editor+ role
    await requireSpaceRole(sql, actor, spaceId, "editor");
  }

  await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM space_entities WHERE space_id = ${spaceId} AND entity_id = ${entityId}`,
  ]);

  backgroundTask(indexEntityById(entityId));

  return new Response(null, { status: 204 });
});

spacesRouter.openapi(grantSpacePermissionRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  // Normalize: single grant body → array, bulk grants body → use grants array
  const isBulk = Array.isArray((body as Record<string, unknown>).grants);
  const rawGrants = isBulk
    ? (body as { grants: Array<Record<string, unknown>> }).grants
    : [body as Record<string, unknown>];

  if (rawGrants.length === 0) {
    throw new ApiError(400, "invalid_body", "At least one grant is required");
  }
  if (rawGrants.length > 100) {
    throw new ApiError(400, "invalid_body", "Maximum 100 grants per request");
  }

  // Validate each grant
  const validRoles = ["contributor", "editor", "admin"];
  const validTypes = ["actor", "group"];
  const grants = rawGrants.map((g, i) => {
    if (typeof g.grantee_id !== "string") {
      throw new ApiError(400, "missing_required_field", `grants[${i}]: missing grantee_id`);
    }
    const granteeType = typeof g.grantee_type === "string" ? g.grantee_type : "actor";
    if (!validTypes.includes(granteeType)) {
      throw new ApiError(400, "invalid_body", `grants[${i}]: invalid grantee_type '${granteeType}'`);
    }
    if (typeof g.role !== "string" || !validRoles.includes(g.role)) {
      throw new ApiError(400, "missing_required_field", `grants[${i}]: missing or invalid role`);
    }
    return { grantee_type: granteeType, grantee_id: g.grantee_id as string, role: g.role as string };
  });

  // Permission check: must be space owner or admin (runs once for the whole batch)
  const space = await requireSpaceRole(sql, actor, spaceId, "admin");
  if (space.owner_id !== actor.id && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Only owner or admin can grant permissions");
  }

  const now = new Date().toISOString();
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    ...grants.map((g) =>
      sql.query(
        `INSERT INTO space_permissions (space_id, grantee_type, grantee_id, role, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (space_id, grantee_type, grantee_id) DO UPDATE SET role = $4, granted_by = $5, granted_at = $6::timestamptz
         RETURNING *`,
        [spaceId, g.grantee_type, g.grantee_id, g.role, actor.id, now],
      ),
    ),
  ]);

  // Extract permission rows (last N results correspond to the N grants)
  const permissions = results.slice(-grants.length).map((r) => (r as SpacePermissionRecord[])[0]);

  if (isBulk) {
    return c.json({ permissions }, 201);
  }
  return c.json({ permission: permissions[0] }, 201);
});

spacesRouter.openapi(revokeSpacePermissionRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const granteeId = c.req.param("granteeId");
  const sql = createSql();

  const space = await requireSpaceRole(sql, actor, spaceId, "admin");
  if (space.owner_id !== actor.id && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Only owner or admin can revoke permissions");
  }

  // space_permissions DELETE RLS depends on session context via the
  // parent-space visibility subquery.
  const deleteResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      DELETE FROM space_permissions
      WHERE space_id = ${spaceId} AND grantee_id = ${granteeId}
      RETURNING space_id
    `,
  ]);
  const rows = deleteResults[deleteResults.length - 1];

  if ((rows as Array<{ space_id: string }>).length === 0) {
    throw new ApiError(404, "not_found", "Permission not found");
  }

  return new Response(null, { status: 204 });
});

spacesRouter.openapi(listSpacePermissionsRoute, async (c) => {
  const sql = createSql();
  const spaceId = c.req.param("id");
  const actorCtx = c.get("actor") ?? null;

  const space = await fetchSpaceForActor(actorCtx, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  // space_permissions RLS also gates on the parent space's visibility, so
  // this read needs actor context too (see space_perms_select in 015-rls).
  const results = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql`
      SELECT space_id, grantee_id, role, granted_at
      FROM space_permissions
      WHERE space_id = ${spaceId}
      ORDER BY granted_at ASC
    `,
  ]);
  const permissions = results[results.length - 1];

  return c.json({ permissions: permissions as SpacePermissionRecord[] }, 200);
});


// -- Space Entity Access handlers ---------------------------------------------

spacesRouter.openapi(grantSpaceEntityAccessRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();

  // Normalize: single grant body → array, bulk grants body → use grants array
  const isBulk = Array.isArray((body as Record<string, unknown>).grants);
  const rawGrants = isBulk
    ? (body as { grants: Array<Record<string, unknown>> }).grants
    : [body as Record<string, unknown>];

  if (rawGrants.length === 0) {
    throw new ApiError(400, "invalid_body", "At least one grant is required");
  }
  if (rawGrants.length > 100) {
    throw new ApiError(400, "invalid_body", "Maximum 100 grants per request");
  }

  // Validate each grant
  const validRoles = ["editor", "admin"];
  const validTypes = ["actor", "group"];
  const grants = rawGrants.map((g, i) => {
    if (typeof g.grantee_id !== "string") {
      throw new ApiError(400, "missing_required_field", `grants[${i}]: missing grantee_id`);
    }
    const granteeType = typeof g.grantee_type === "string" ? g.grantee_type : "actor";
    if (!validTypes.includes(granteeType)) {
      throw new ApiError(400, "invalid_body", `grants[${i}]: invalid grantee_type '${granteeType}'`);
    }
    if (typeof g.role !== "string" || !validRoles.includes(g.role)) {
      throw new ApiError(400, "missing_required_field", `grants[${i}]: missing or invalid role (must be editor or admin)`);
    }
    return { grantee_type: granteeType, grantee_id: g.grantee_id as string, role: g.role as string };
  });

  // Permission check: must have admin role on space (owner, space admin grant, or system admin)
  await requireSpaceRole(sql, actor, spaceId, "admin");

  const now = new Date().toISOString();
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    ...grants.map((g) =>
      sql.query(
        `INSERT INTO space_entity_access (space_id, grantee_type, grantee_id, role, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (space_id, grantee_type, grantee_id) DO UPDATE SET role = $4, granted_by = $5, granted_at = $6::timestamptz
         RETURNING *`,
        [spaceId, g.grantee_type, g.grantee_id, g.role, actor.id, now],
      ),
    ),
  ]);

  const rows = results.slice(-grants.length).map((r) => (r as SpaceEntityAccessRecord[])[0]);

  if (isBulk) {
    return c.json({ grants: rows }, 201);
  }
  return c.json({ grant: rows[0] }, 201);
});

spacesRouter.openapi(revokeSpaceEntityAccessRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const granteeId = c.req.param("granteeId");
  const sql = createSql();

  await requireSpaceRole(sql, actor, spaceId, "admin");

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM space_entity_access
        WHERE space_id = ${spaceId} AND grantee_id = ${granteeId}
        RETURNING space_id`,
  ]);
  const rows = results[results.length - 1];

  if ((rows as Array<{ space_id: string }>).length === 0) {
    throw new ApiError(404, "not_found", "Entity access grant not found");
  }

  return new Response(null, { status: 204 });
});

spacesRouter.openapi(listSpaceEntityAccessRoute, async (c) => {
  const sql = createSql();
  const spaceId = c.req.param("id");
  const actorCtx = c.get("actor") ?? null;

  const space = await fetchSpaceForActor(actorCtx, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const results = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql`
      SELECT space_id, grantee_type, grantee_id, role, granted_by, granted_at
      FROM space_entity_access
      WHERE space_id = ${spaceId}
      ORDER BY granted_at ASC
    `,
  ]);
  const grants = results[results.length - 1];

  return c.json({ grants: grants as SpaceEntityAccessRecord[] }, 200);
});

