// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { ApiError } from "../lib/errors";
import {
  requireActor,
  parseJsonBody,
  parseLimit,
  parseCursorParam,
} from "../lib/http";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { createApiKey, sha256Hex } from "../lib/auth";
import {
  ActorSchema,
  EntityIdParam,
  JsonObjectSchema,
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

type ActorRecord = {
  id: string;
  kind: string;
  owner_id: string | null;
  properties: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
};

const createActorRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createActor",
  tags: ["Actors"],
  summary: "Create a new actor and its initial API key",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /actors/{id}", "GET /actors"],
  "x-arke-rules": [],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          kind: z.enum(["agent"]).describe("Actor kind (only 'agent' is supported)"),
          properties: JsonObjectSchema.optional().describe("Actor properties"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Actor created with initial API key",
      content: jsonContent(
        z.object({
          actor: ActorSchema,
          api_key: z.string().describe("Plaintext API key (only shown once)"),
        }),
      ),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listActorsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listActors",
  tags: ["Actors"],
  summary: "List actors (paginated)",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /actors", "GET /actors/{id}"],
  "x-arke-rules": [],
  request: {
    query: paginationQuerySchema(50, 200).extend({
      status: queryParam(
        "status",
        z.enum(["active", "suspended", "deactivated"]).optional(),
        "Filter by status",
      ),
      kind: queryParam(
        "kind",
        z.enum(["agent"]).optional(),
        "Filter by kind",
      ),
    }),
  },
  responses: {
    200: {
      description: "Actor listing",
      content: jsonContent(cursorResponseSchema("actors", ActorSchema)),
    },
    ...errorResponses([400, 401]),
  },
});

const getActorRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getActor",
  tags: ["Actors"],
  summary: "Fetch a single actor by ID",
  "x-arke-auth": "required",
  "x-arke-related": ["PUT /actors/{id}", "DELETE /actors/{id}"],
  "x-arke-rules": [],
  request: {
    params: entityIdParams("Actor ULID"),
  },
  responses: {
    200: {
      description: "Actor details",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([401, 404]),
  },
});

const updateActorRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateActor",
  tags: ["Actors"],
  summary: "Update an actor",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /actors/{id}"],
  "x-arke-rules": [],
  request: {
    params: entityIdParams("Actor ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          properties: JsonObjectSchema.optional().describe("New properties"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Actor updated",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const deactivateActorRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deactivateActor",
  tags: ["Actors"],
  summary: "Deactivate an actor",
  "x-arke-auth": "required",
  "x-arke-rules": [],
  request: {
    params: entityIdParams("Actor ULID"),
  },
  responses: {
    200: {
      description: "Actor deactivated",
      content: jsonContent(z.object({ actor: ActorSchema })),
    },
    ...errorResponses([401, 403, 404]),
  },
});

const createActorKeyRoute = createRoute({
  method: "post",
  path: "/{id}/keys",
  operationId: "createActorKey",
  tags: ["Actors"],
  summary: "Create an API key for a specific actor",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/keys", "POST /auth/keys"],
  "x-arke-rules": ["Target actor must be active"],
  request: {
    params: entityIdParams("Actor ULID"),
    body: {
      content: jsonContent(
        z.object({
          label: z.string().optional().describe("Optional key label"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "API key created (key value returned once)",
      content: jsonContent(
        z.object({
          id: EntityIdParam,
          key_prefix: z.string(),
          api_key: z.string(),
          label: z.string().nullable(),
        }),
      ),
    },
    ...errorResponses([401, 403, 404]),
  },
});

export const actorsRouter = createRouter();

actorsRouter.openapi(createActorRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  if (body.kind !== undefined && body.kind !== "agent") {
    throw new ApiError(400, "invalid_kind", "kind must be 'agent' (the only supported actor kind)");
  }

  const properties = body.properties && typeof body.properties === "object" ? body.properties : {};

  const id = generateUlid();
  const now = new Date().toISOString();
  const key = createApiKey();
  const keyHash = await sha256Hex(key.value);
  const sql = createSql();
  const keyId = generateUlid();

  // Agent flow: create key and return it
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `INSERT INTO actors (id, kind, owner_id, properties, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, 'active', $5::timestamptz, $5::timestamptz)
       RETURNING *`,
      [id, body.kind, actor.id, JSON.stringify(properties), now],
    ),
    sql.query(
      `INSERT INTO api_keys (id, actor_id, key_hash, key_prefix, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [keyId, id, keyHash, key.keyPrefix, now],
    ),
  ]);

  const created = (results.at(-2) as ActorRecord[])[0];
  if (!created) {
    throw new ApiError(500, "internal_error", "Failed to create actor");
  }

  return c.json({ actor: created, api_key: key.value }, 201);
});

actorsRouter.openapi(listActorsRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql();
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const status = c.req.query("status");
  const kind = c.req.query("kind");

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        SELECT *
        FROM actors
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
        ORDER BY created_at DESC
        LIMIT $4
      `,
      [status ?? null, kind ?? null, cursor?.t ?? null, limit + 1],
    ),
  ]);
  const rows = results.at(-1) as ActorRecord[];

  const actors = (rows as ActorRecord[]).slice(0, limit);
  const next = (rows as ActorRecord[]).length > limit ? actors[actors.length - 1] : null;

  return c.json({
    actors,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.id }) : null,
  }, 200);
});

actorsRouter.openapi(getActorRoute, async (c) => {
  requireActor(c);
  const sql = createSql();
  const actorId = c.req.param("id");

  const [row] = await sql`SELECT * FROM actors WHERE id = ${actorId} LIMIT 1`;
  if (!row) {
    throw new ApiError(404, "not_found", "Actor not found");
  }

  return c.json({ actor: row as ActorRecord }, 200);
});

actorsRouter.openapi(updateActorRoute, async (c) => {
  const actor = requireActor(c);
  const actorId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

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
  params.push(actorId);

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE actors
        SET ${sets.join(", ")}
        WHERE id = $${idParamIdx}
        RETURNING *
      `,
      params,
    ),
  ]);
  const rows = results.at(-1) as ActorRecord[];

  const updated = (rows as ActorRecord[])[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Actor not found");
  }

  return c.json({ actor: updated }, 200);
});

actorsRouter.openapi(deactivateActorRoute, async (c) => {
  const actor = requireActor(c);
  const actorId = c.req.param("id");
  const sql = createSql();
  const now = new Date().toISOString();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        UPDATE actors
        SET status = 'deactivated', updated_at = $1::timestamptz
        WHERE id = $2
        RETURNING *
      `,
      [now, actorId],
    ),
  ]);
  const rows = results.at(-1) as ActorRecord[];

  const deactivated = (rows as ActorRecord[])[0];
  if (!deactivated) {
    throw new ApiError(404, "not_found", "Actor not found");
  }

  return c.json({ actor: deactivated }, 200);
});

actorsRouter.openapi(createActorKeyRoute, async (c) => {
  const actor = requireActor(c);
  const actorId = c.req.param("id");
  const sql = createSql();

  // Verify target actor exists and is active
  const [target] = await sql`SELECT id, status FROM actors WHERE id = ${actorId} LIMIT 1`;
  if (!target) {
    throw new ApiError(404, "not_found", "Actor not found");
  }
  if ((target as ActorRecord).status !== "active") {
    throw new ApiError(400, "invalid_state", "Actor is not active");
  }

  let body: Record<string, unknown> = {};
  if (c.req.header("content-length") !== "0") {
    body = await parseJsonBody<Record<string, unknown>>(c).catch(() => ({}));
  }
  const label =
    body.label === undefined ? null : typeof body.label === "string" ? body.label : null;

  const apiKey = createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.value);
  const keyId = generateUlid();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      INSERT INTO api_keys (id, key_prefix, key_hash, actor_id, label)
      VALUES (${keyId}, ${apiKey.keyPrefix}, ${apiKeyHash}, ${actorId}, ${label})
      RETURNING id, key_prefix, label
    `,
  ]);

  return c.json(
    {
      ...(results[results.length - 1] as Array<Record<string, unknown>>)[0],
      api_key: apiKey.value,
    },
    201,
  );
});

