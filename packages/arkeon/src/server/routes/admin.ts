// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireAdmin, parseJsonBody } from "../lib/http";
import { bulkIndexEntities, ensureMeiliIndex, isMeilisearchConfigured } from "../lib/meilisearch";
import { createRouter } from "../lib/openapi";
import {
  ActorSchema,
  ClassificationLevel,
  EntityIdParam,
  JsonObjectSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
} from "../lib/schemas";
import { setActorContext, withSystemActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";

// --- Route definitions ---

const updateAdminActorRoute = createRoute({
  method: "put",
  path: "/actors/{id}",
  operationId: "adminUpdateActor",
  tags: ["Admin"],
  summary: "Update actor admin-only fields (is_admin, status, can_publish_public)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /actors/{id}", "PUT /actors/{id}"],
  "x-arke-rules": ["System admin only"],
  request: {
    params: entityIdParams("Actor ULID"),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          is_admin: z.boolean().optional().describe("System admin flag"),
          status: z
            .enum(["active", "suspended", "deactivated"])
            .optional()
            .describe("Actor status"),
          can_publish_public: z
            .boolean()
            .optional()
            .describe("Whether actor can publish public (read_level=0) content"),
          max_read_level: ClassificationLevel.optional().describe("Max read level (0-4)"),
          max_write_level: ClassificationLevel.optional().describe("Max write level (0-4)"),
          properties: JsonObjectSchema.optional().describe("Actor properties"),
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

const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  operationId: "getInstanceStats",
  tags: ["Admin"],
  summary: "Get instance statistics (entity, actor, relationship counts and DB size)",
  "x-arke-auth": "required",
  "x-arke-rules": ["System admin only"],
  responses: {
    200: {
      description: "Instance statistics",
      content: jsonContent(
        z.object({
          stats: z.object({
            entity_count: z.number().int(),
            actor_count: z.number().int(),
            relationship_count: z.number().int(),
            db_size_bytes: z.number().int(),
          }),
        }),
      ),
    },
    ...errorResponses([401, 403]),
  },
});

const instanceRoute = createRoute({
  method: "get",
  path: "/instance",
  operationId: "getInstanceInfo",
  tags: ["Admin"],
  summary: "Get instance metadata (Arke ID, version)",
  "x-arke-auth": "required",
  "x-arke-rules": ["System admin only"],
  responses: {
    200: {
      description: "Instance metadata",
      content: jsonContent(
        z.object({
          version: z.string(),
        }),
      ),
    },
    ...errorResponses([401, 403]),
  },
});

const reindexRoute = createRoute({
  method: "post",
  path: "/reindex",
  operationId: "adminReindex",
  tags: ["Admin"],
  summary: "Rebuild the Meilisearch index from Postgres",
  "x-arke-auth": "required",
  "x-arke-rules": ["System admin only"],
  responses: {
    200: {
      description: "Reindex result",
      content: jsonContent(
        z.object({
          indexed: z.number().int(),
        }),
      ),
    },
    ...errorResponses([401, 403, 409]),
  },
});


// --- Handlers ---

export const adminRouter = createRouter();

adminRouter.openapi(updateAdminActorRoute, async (c) => {
  const actor = requireAdmin(c);
  const actorId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (typeof body.is_admin === "boolean") {
    sets.push(`is_admin = $${paramIdx++}`);
    params.push(body.is_admin);
  }
  if (typeof body.status === "string" && ["active", "suspended", "deactivated"].includes(body.status)) {
    sets.push(`status = $${paramIdx++}`);
    params.push(body.status);
  }
  if (typeof body.can_publish_public === "boolean") {
    sets.push(`can_publish_public = $${paramIdx++}`);
    params.push(body.can_publish_public);
  }
  if (typeof body.max_read_level === "number") {
    sets.push(`max_read_level = $${paramIdx++}`);
    params.push(body.max_read_level);
  }
  if (typeof body.max_write_level === "number") {
    sets.push(`max_write_level = $${paramIdx++}`);
    params.push(body.max_write_level);
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

  const updated = (results.at(-1) as Array<Record<string, unknown>>)[0];
  if (!updated) {
    throw new ApiError(404, "not_found", "Actor not found");
  }

  return c.json({ actor: updated }, 200);
});

adminRouter.openapi(statsRoute, async (c) => {
  const actor = requireAdmin(c);
  const sql = createSql();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT
        (SELECT count(*)::int FROM entities) AS entity_count,
        (SELECT count(*)::int FROM actors) AS actor_count,
        (SELECT count(*)::int FROM relationship_edges) AS relationship_count,
        (SELECT pg_database_size(current_database())) AS db_size_bytes`,
    ),
  ]);

  const row = (results.at(-1) as Array<Record<string, unknown>>)[0];
  return c.json({ stats: row }, 200);
});

adminRouter.openapi(instanceRoute, async (c) => {
  requireAdmin(c);

  return c.json(
    {
      version: "2.0.0",
    },
    200,
  );
});

adminRouter.openapi(reindexRoute, async (c) => {
  requireAdmin(c);

  if (!isMeilisearchConfigured()) {
    throw new ApiError(409, "not_available", "Meilisearch is not configured (MEILI_URL not set)");
  }

  await ensureMeiliIndex();

  const BATCH_SIZE = 1000;

  // Pre-fetch all space memberships under a system-level RLS context.
  // A bare read here would only return rows for level-0 spaces, producing
  // a search index with missing `space_ids` for every non-public space.
  // We do NOT hold this transaction across the Meilisearch calls below —
  // snapshot the memberships, commit, then stream entity batches.
  const spaceIdMap = await withSystemActorContext(async (tx) => {
    const spaceRows = await tx`SELECT entity_id, space_id FROM space_entities`;
    const map = new Map<string, string[]>();
    for (const row of spaceRows as Array<{ entity_id: string; space_id: string }>) {
      const existing = map.get(row.entity_id);
      if (existing) {
        existing.push(row.space_id);
      } else {
        map.set(row.entity_id, [row.space_id]);
      }
    }
    return map;
  });

  let cursor: string | null = null;
  let total = 0;

  // Each batch runs in its own short-lived transaction so we don't pin
  // a connection across the Meilisearch HTTP write.
  while (true) {
    const entities = await withSystemActorContext(async (tx) => {
      const rows = cursor
        ? await tx`SELECT * FROM entities WHERE id > ${cursor} ORDER BY id LIMIT ${BATCH_SIZE}`
        : await tx`SELECT * FROM entities ORDER BY id LIMIT ${BATCH_SIZE}`;
      return rows as Record<string, unknown>[];
    });

    if (entities.length === 0) break;

    await bulkIndexEntities(entities, spaceIdMap);
    total += entities.length;
    cursor = String(entities[entities.length - 1].id);
  }

  return c.json({ indexed: total }, 200);
});

