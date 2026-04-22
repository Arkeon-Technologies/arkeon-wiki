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
import { indexEntityById, removeEntities } from "../lib/meilisearch";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { encodeCursor } from "../lib/cursor";
import {
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
import { fetchSpaceForActor, type SpaceRecord } from "../lib/spaces";

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
  summary: "List spaces (paginated)",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /spaces", "GET /spaces/{id}"],
  "x-arke-rules": [],
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
  "x-arke-rules": [],
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
  summary: "Update a space",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /spaces/{id}"],
  "x-arke-rules": [],
  request: {
    params: entityIdParams("Space ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          name: z.string().min(1).optional().describe("New name"),
          description: z.string().nullable().optional().describe("New description"),
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
  summary: "Delete a space and its orphaned entities",
  "x-arke-auth": "required",
  "x-arke-rules": [
    "Entities that belong only to this space are permanently deleted",
    "Entities shared with other spaces lose membership but are not deleted",
  ],
  request: {
    params: entityIdParams("Space ULID"),
  },
  responses: {
    204: { description: "Space deleted" },
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
  "x-arke-rules": [],
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
  summary: "Add an entity to a space",
  "x-arke-auth": "required",
  "x-arke-related": ["DELETE /spaces/{id}/entities/{entityId}"],
  "x-arke-rules": [],
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
  summary: "Remove an entity from a space",
  "x-arke-auth": "required",
  "x-arke-rules": [],
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

const FocusBodySchema = z.object({
  extract: z.string().optional().describe("Focus prompt for the extract worker — guides what subjects to extract from documents"),
  draft: z.string().optional().describe("Focus prompt for the draft worker — guides how wiki articles are written"),
}).catchall(z.string().describe("Focus prompt for a named worker"));

const FocusResponseSchema = z.object({
  focus: z.record(z.string(), z.string()).describe("Per-worker focus prompts"),
});

const setSpaceFocusRoute = createRoute({
  method: "put",
  path: "/{id}/focus",
  operationId: "setSpaceFocus",
  tags: ["Spaces"],
  summary: "Set extraction focus prompts for a space",
  description: "Set per-worker focus prompts that guide extraction and drafting. Merges with existing focus — omitted keys are preserved. Pass empty string to clear a single worker's focus.",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /spaces/{id}/focus", "DELETE /spaces/{id}/focus"],
  "x-arke-rules": ["Focus prompts are appended to built-in worker prompts at processing time"],
  request: {
    params: entityIdParams("Space ULID"),
    body: { required: true, content: jsonContent(FocusBodySchema) },
  },
  responses: {
    200: {
      description: "Focus updated",
      content: jsonContent(FocusResponseSchema),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const getSpaceFocusRoute = createRoute({
  method: "get",
  path: "/{id}/focus",
  operationId: "getSpaceFocus",
  tags: ["Spaces"],
  summary: "Get extraction focus prompts for a space",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /spaces/{id}/focus"],
  "x-arke-rules": [],
  request: {
    params: entityIdParams("Space ULID"),
  },
  responses: {
    200: {
      description: "Current focus prompts",
      content: jsonContent(FocusResponseSchema),
    },
    ...errorResponses([404]),
  },
});

const clearSpaceFocusRoute = createRoute({
  method: "delete",
  path: "/{id}/focus",
  operationId: "clearSpaceFocus",
  tags: ["Spaces"],
  summary: "Clear all extraction focus prompts for a space",
  "x-arke-auth": "required",
  "x-arke-related": ["PUT /spaces/{id}/focus"],
  "x-arke-rules": [],
  request: {
    params: entityIdParams("Space ULID"),
  },
  responses: {
    204: { description: "Focus cleared" },
    ...errorResponses([401, 403, 404]),
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
  const properties = body.properties && typeof body.properties === "object" ? body.properties : {};

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        INSERT INTO spaces (id, name, description, owner_id, status, entity_count, properties, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', 0, $5::jsonb, $6::timestamptz, $6::timestamptz)
        RETURNING *
      `,
      [id, body.name, description, actor.id, JSON.stringify(properties), now],
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
  const actor = c.get("actor") ?? null;
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const q = c.req.query("q");

  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        SELECT *
        FROM spaces
        WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
          AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
        ORDER BY created_at DESC
        LIMIT $3
      `,
      [q ?? null, cursor?.t ?? null, limit + 1],
    ),
  ]);

  const rows = txResults[txResults.length - 1] as SpaceRecord[];
  const spaces = rows.slice(0, limit);
  const next = rows.length > limit ? spaces[spaces.length - 1] : null;

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

  const space = await fetchSpaceForActor(actor, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

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

  const txResults = await sql.transaction([
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
  const updated = (txResults[txResults.length - 1] as SpaceRecord[])[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  return c.json({ space: updated }, 200);
});

spacesRouter.openapi(deleteSpaceRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const sql = createSql();

  // Collect member entity IDs before CASCADE removes space_entities, then hard-delete the space
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(`SELECT entity_id FROM space_entities WHERE space_id = $1`, [spaceId]),
    sql.query(`DELETE FROM spaces WHERE id = $1 RETURNING id`, [spaceId]),
  ]);

  // Results: [...setActorContext, memberQuery, deleteQuery] — index from the end
  const deletedRows = results.at(-1) as Array<{ id: string }>;
  const memberRows = results.at(-2) as Array<{ entity_id: string }>;

  if (deletedRows.length === 0) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  // Delete orphaned entities (no remaining space memberships) and clean up search index
  const memberIds = memberRows.map((r) => r.entity_id);
  if (memberIds.length > 0) {
    const orphanResults = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `DELETE FROM entities WHERE id = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM space_entities se WHERE se.entity_id = entities.id)
         RETURNING id`,
        [memberIds],
      ),
    ]);
    const orphanIds = (orphanResults[orphanResults.length - 1] as Array<{ id: string }>).map((r) => r.id);
    if (orphanIds.length > 0) {
      backgroundTask(removeEntities(orphanIds));
    }
  }

  return new Response(null, { status: 204 });
});

spacesRouter.openapi(listSpaceEntitiesRoute, async (c) => {
  const sql = createSql();
  const spaceId = c.req.param("id");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);

  // Verify space exists
  const space = await fetchSpaceForActor(null, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const rows = await sql.query(
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
  ) as Array<Record<string, unknown>>;
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

  const space = await fetchSpaceForActor(actor, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

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

  const space = await fetchSpaceForActor(actor, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const entryRows = await sql`
    SELECT added_by FROM space_entities
    WHERE space_id = ${spaceId} AND entity_id = ${entityId}
    LIMIT 1
  `;
  if (entryRows.length === 0) {
    throw new ApiError(404, "not_found", "Entity not in space");
  }

  await sql`DELETE FROM space_entities WHERE space_id = ${spaceId} AND entity_id = ${entityId}`;

  backgroundTask(indexEntityById(entityId));

  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Focus routes
// ---------------------------------------------------------------------------

spacesRouter.openapi(setSpaceFocusRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  const space = await fetchSpaceForActor(actor, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  // Validate: all values must be strings
  const focus: Record<string, string> = {};
  for (const [key, val] of Object.entries(body)) {
    if (typeof val !== "string") {
      throw new ApiError(400, "invalid_body", `focus.${key} must be a string`);
    }
    focus[key] = val;
  }

  if (Object.keys(focus).length === 0) {
    throw new ApiError(400, "invalid_body", "At least one focus prompt is required");
  }

  // Merge with existing focus (omitted keys are preserved, empty strings clear a key)
  const existingFocus = (space.properties?.focus as Record<string, string>) ?? {};
  const merged: Record<string, string> = { ...existingFocus };
  for (const [key, val] of Object.entries(focus)) {
    if (val === "") {
      delete merged[key];
    } else {
      merged[key] = val;
    }
  }

  // Update properties with new focus
  const updatedProps = { ...space.properties, focus: merged };

  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `UPDATE spaces SET properties = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3 RETURNING *`,
      [JSON.stringify(updatedProps), now, spaceId],
    ),
  ]);

  const updated = (txResults[txResults.length - 1] as SpaceRecord[])[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  return c.json({ focus: merged }, 200);
});

spacesRouter.openapi(getSpaceFocusRoute, async (c) => {
  const spaceId = c.req.param("id");
  const actor = c.get("actor") ?? null;

  const space = await fetchSpaceForActor(actor, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const focus = (space.properties?.focus as Record<string, string>) ?? {};
  return c.json({ focus }, 200);
});

spacesRouter.openapi(clearSpaceFocusRoute, async (c) => {
  const actor = requireActor(c);
  const spaceId = c.req.param("id");
  const sql = createSql();
  const now = new Date().toISOString();

  const space = await fetchSpaceForActor(actor, spaceId);
  if (!space) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const { focus: _, ...restProps } = space.properties ?? {};

  await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `UPDATE spaces SET properties = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3`,
      [JSON.stringify(restProps), now, spaceId],
    ),
  ]);

  return new Response(null, { status: 204 });
});
