// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { ApiError } from "../lib/errors";
import { parseCursorParam, parseLimit } from "../lib/http";
import { setActorContext } from "../lib/actor-context";
import { createRouter } from "../lib/openapi";
import {
  EntityIdParam,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";

const RelationshipSummarySchema = z.object({
  id: EntityIdParam,
  predicate: z.string(),
  source_id: EntityIdParam,
  target_id: EntityIdParam,
  direction: z.enum(["in", "out"]).describe("Whether this entity is the source (out) or target (in)"),
  properties: z.record(z.string(), z.any()),
  source: z.any().optional(),
  target: z.any().optional(),
});

const listRelationshipsRoute = createRoute({
  method: "get",
  path: "/{id}/relationships",
  operationId: "listRelationships",
  tags: ["Relationships"],
  summary: "List relationships for a wiki entity",
  description:
    "Relationships are created by the wiki pipeline when `[[links]]` in a wiki body are parsed and resolved. " +
    "There is no public endpoint for creating relationships directly — they are a pure side effect of publishing a wiki.",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /wiki/{id}", "GET /relationships/{relId}"],
  "x-arke-rules": [],
  request: {
    params: entityIdParams(),
    query: paginationQuerySchema(50, 200).extend({
      direction: queryParam("direction", z.enum(["in", "out", "both"]).optional(), "in | out | both (default: both)"),
      predicate: queryParam("predicate", z.string().optional(), "Filter by predicate string"),
      target_id: queryParam("target_id", z.string().optional(), "Filter by specific target or source"),
    }),
  },
  responses: {
    200: {
      description: "Relationships for the entity",
      content: jsonContent(cursorResponseSchema("relationships", RelationshipSummarySchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const getRelationshipRoute = createRoute({
  method: "get",
  path: "/{relId}",
  operationId: "getRelationship",
  tags: ["Relationships"],
  summary: "Get a relationship by its ID with source/target details",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /wiki/{id}/relationships"],
  "x-arke-rules": [],
  request: {
    params: z.object({
      relId: pathParam("relId", EntityIdParam, "Relationship entity ULID"),
    }),
  },
  responses: {
    200: {
      description: "Relationship details",
      content: jsonContent(
        z.object({
          id: EntityIdParam,
          predicate: z.string(),
          source_id: EntityIdParam,
          target_id: EntityIdParam,
          properties: z.record(z.string(), z.any()),
          source: z.any(),
          target: z.any(),
        }),
      ),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const wikiRelationshipsRouter = createRouter();
export const relationshipDirectRouter = createRouter();

wikiRelationshipsRouter.openapi(listRelationshipsRoute, async (c) => {
  const sql = createSql();
  const entityId = c.req.param("id");
  const dirParam = c.req.query("direction");
  const direction = dirParam === "in" || dirParam === "out" ? dirParam : "both";
  const predicate = c.req.query("predicate");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const targetId = c.req.query("target_id");

  // Build WHERE clause based on direction
  const directionFilter =
    direction === "out" ? "re.source_id = $1"
    : direction === "in" ? "re.target_id = $1"
    : "(re.source_id = $1 OR re.target_id = $1)";

  const actorCtx = c.get("actor");
  const results = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT
          rel.id,
          re.predicate,
          re.source_id,
          re.target_id,
          rel.properties,
          CASE WHEN re.source_id = $1 THEN 'out' ELSE 'in' END AS direction,
          json_build_object(
            'id', other.id,
            'kind', other.kind,
            'type', other.type,
            'properties', other.properties
          ) AS counterpart,
          rel.created_at
        FROM relationship_edges re
        JOIN entities rel ON rel.id = re.id
        JOIN entities other ON other.id = CASE WHEN re.source_id = $1 THEN re.target_id ELSE re.source_id END
        WHERE ${directionFilter}
          AND ($2::text IS NULL OR re.predicate = $2)
          AND ($3::text IS NULL OR re.target_id = $3 OR re.source_id = $3)
          AND ($4::timestamptz IS NULL OR (rel.created_at, rel.id) < ($4::timestamptz, $5::text))
        ORDER BY rel.created_at DESC, rel.id DESC
        LIMIT $6
      `,
      [entityId, predicate ?? null, targetId ?? null, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
  ]);
  const rows = results.at(-1) as Array<Record<string, unknown>>;

  const page = rows.slice(0, limit);
  const next = rows.length > limit ? page[page.length - 1] : null;

  return c.json({
    relationships: page.map((row) => {
      const dir = row.direction as string;
      return {
        id: row.id,
        predicate: row.predicate,
        source_id: row.source_id,
        target_id: row.target_id,
        direction: dir,
        properties: row.properties,
        [dir === "in" ? "source" : "target"]: row.counterpart,
      };
    }),
    cursor: next ? encodeCursor({ t: next.created_at as string | Date, i: String(next.id) }) : null,
  }, 200);
});

relationshipDirectRouter.openapi(getRelationshipRoute, async (c) => {
  const sql = createSql();
  const relId = c.req.param("relId");

  const actorCtx = c.get("actor");
  const results = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT
          rel.*,
          re.predicate,
          re.source_id,
          re.target_id,
          json_build_object('id', source.id, 'kind', source.kind, 'type', source.type, 'properties', source.properties) AS source,
          json_build_object('id', target.id, 'kind', target.kind, 'type', target.type, 'properties', target.properties) AS target
        FROM entities rel
        JOIN relationship_edges re ON re.id = rel.id
        JOIN entities source ON source.id = re.source_id
        JOIN entities target ON target.id = re.target_id
        WHERE rel.id = $1
        LIMIT 1
      `,
      [relId],
    ),
  ]);
  const rows = results.at(-1) as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) {
    throw new ApiError(404, "not_found", "Relationship not found");
  }

  return c.json(row, 200);
});
