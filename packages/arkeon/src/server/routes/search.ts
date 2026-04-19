// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { parseProjection, projectEntity } from "../lib/entity-projection";
import { ApiError } from "../lib/errors";
import { parseLimit, parseJsonBody } from "../lib/http";
import {
  buildSearchFilters,
  isMeilisearchConfigured,
  multiSearchEntities,
  searchEntities,
} from "../lib/meilisearch";
import { createRouter } from "../lib/openapi";
import { fetchRelationshipContext } from "../lib/relationship-context";
import {
  EntitySchema,
  ExpandedEntitySchema,
  ProjectionQuery,
  errorResponses,
  jsonContent,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";

const SearchQuery = ProjectionQuery.extend({
  q: queryParam("q", z.string().min(1), "Search query string"),
  type: queryParam("type", z.string().optional(), "Filter by entity type"),
  kind: queryParam(
    "kind",
    z.string().optional(),
    "Filter by kind (entity or relationship). Defaults to excluding relationships.",
  ),
  space_id: queryParam(
    "space_id",
    z.string().optional(),
    "Scope search to a space ULID",
  ),
  limit: queryParam(
    "limit",
    z.coerce.number().int().min(1).max(200).optional(),
    "Page size (default 50, max 200)",
  ),
  offset: queryParam(
    "offset",
    z.coerce.number().int().min(0).optional(),
    "Offset for pagination (default 0)",
  ),
  rel_limit: queryParam(
    "rel_limit",
    z.coerce.number().int().min(1).max(100).optional(),
    "Max relationships per result when view=expanded (default 5, max 100)",
  ),
});

const searchRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "searchEntities",
  tags: ["Search"],
  summary: "Full-text search across entities via Meilisearch",
  description:
    "Keyword search with typo tolerance, prefix matching, and relevance ranking. " +
    "Use view=expanded to include each result's relationships with counterpart summaries.",
  "x-arke-auth": "optional",
  "x-arke-rules": [],
  request: {
    query: SearchQuery,
  },
  responses: {
    200: {
      description: "Search results ordered by relevance. When view=expanded, each result includes _relationships and _relationships_truncated. Each result includes space_ids.",
      content: jsonContent(
        z.object({
          results: z.array(z.union([
            EntitySchema.extend({ space_ids: z.array(z.string()).describe("Space ULIDs this entity belongs to") }),
            ExpandedEntitySchema.extend({ space_ids: z.array(z.string()).describe("Space ULIDs this entity belongs to") }),
          ])),
          estimatedTotalHits: z.number().int(),
          limit: z.number().int(),
          offset: z.number().int(),
        }),
      ),
    },
    ...errorResponses([400, 503]),
  },
});

const MultiSearchQuerySchema = z.object({
  q: z.string().min(1).describe("Search query string"),
  type: z.string().optional().describe("Filter by entity type"),
  kind: z.string().optional().describe("Filter by kind (entity or relationship)"),
  space_id: z.string().optional().describe("Scope to a space ULID"),
  limit: z.number().int().min(1).max(50).optional().describe("Per-query limit (default 20, max 50)"),
  offset: z.number().int().min(0).optional().describe("Per-query offset (default 0)"),
});

const multiSearchRoute = createRoute({
  method: "post",
  path: "/multi",
  operationId: "multiSearch",
  tags: ["Search"],
  summary: "Execute multiple search queries in one request",
  description:
    "Batch up to 10 independent search queries. Each query runs against Meilisearch " +
    "with its own filters. All results are enriched from Postgres in a single transaction. " +
    "Shared view/fields params apply to all results.",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /search"],
  "x-arke-rules": [],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          queries: z.array(MultiSearchQuerySchema).min(1).max(10)
            .describe("Search queries (max 10)"),
          view: z.enum(["summary", "expanded"]).optional()
            .describe("Projection applied to all results"),
          fields: z.string().optional()
            .describe("Comma-separated field list applied to all results"),
          rel_limit: z.number().int().min(1).max(100).optional()
            .describe("Max relationships per result when view=expanded (default 5, max 100)"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Array of search result sets, one per query. When view=expanded, each result includes _relationships and _relationships_truncated. Each result includes space_ids.",
      content: jsonContent(
        z.object({
          results: z.array(
            z.object({
              q: z.string(),
              results: z.array(z.union([
                EntitySchema.extend({ space_ids: z.array(z.string()).describe("Space ULIDs this entity belongs to") }),
                ExpandedEntitySchema.extend({ space_ids: z.array(z.string()).describe("Space ULIDs this entity belongs to") }),
              ])),
              estimatedTotalHits: z.number().int(),
              limit: z.number().int(),
              offset: z.number().int(),
            }),
          ),
        }),
      ),
    },
    ...errorResponses([400, 503]),
  },
});

export const searchRouter = createRouter();

// --- GET /search handler ---

searchRouter.openapi(searchRoute, async (c) => {
  if (!isMeilisearchConfigured()) {
    throw new ApiError(503, "service_unavailable", "Search is not available (MEILI_URL not configured)");
  }

  const q = c.req.query("q");
  if (!q) {
    throw new ApiError(400, "missing_required_field", "Missing q");
  }

  const actor = c.get("actor");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));

  const filters = buildSearchFilters({
    type: c.req.query("type"),
    kind: c.req.query("kind"),
    spaceId: c.req.query("space_id"),
  });

  const meiliResult = await searchEntities(q, {
    filter: filters,
    limit,
    offset,
  });

  if (meiliResult.ids.length === 0) {
    return c.json({ results: [], estimatedTotalHits: 0, limit, offset }, 200);
  }

  // Fetch full entities from Postgres by ID (RLS backstop) + their space_ids
  const sql = createSql();
  const placeholders = meiliResult.ids.map((_, i) => `$${i + 1}`).join(", ");
  const ctxQueries = setActorContext(sql, actor);
  const txResults = await sql.transaction([
    ...ctxQueries,
    sql.query(
      `SELECT * FROM entities WHERE id IN (${placeholders})`,
      meiliResult.ids,
    ),
    sql.query(
      `SELECT entity_id, array_agg(space_id) AS space_ids FROM space_entities WHERE entity_id IN (${placeholders}) GROUP BY entity_id`,
      meiliResult.ids,
    ),
  ]);

  const entityRows = txResults[ctxQueries.length] as Array<Record<string, unknown>>;
  const spaceRows = txResults[ctxQueries.length + 1] as Array<{ entity_id: string; space_ids: string[] }>;

  const spaceMap = new Map<string, string[]>();
  for (const row of spaceRows) {
    spaceMap.set(row.entity_id, row.space_ids);
  }

  const rowMap = new Map<string, Record<string, unknown>>();
  for (const row of entityRows) {
    row.space_ids = spaceMap.get(String(row.id)) ?? [];
    rowMap.set(String(row.id), row);
  }

  // Preserve Meilisearch relevance order, filter out rows hidden by RLS
  const results = meiliResult.ids
    .map((id) => rowMap.get(id))
    .filter((row): row is Record<string, unknown> => row !== undefined);

  if (projection.view === "expanded" && results.length > 0) {
    const relLimit = Math.min(Number(c.req.query("rel_limit")) || 5, 100);
    const visibleIds = results.map((r) => String(r.id));
    const relMap = await fetchRelationshipContext(sql, actor, visibleIds, relLimit);

    return c.json({
      results: results.map((row) => {
        const ctx = relMap.get(String(row.id));
        return {
          ...projectEntity(row, { view: "full", fields: null }),
          _relationships: ctx?.items ?? [],
          _relationships_truncated: ctx?.truncated ?? false,
        };
      }),
      estimatedTotalHits: meiliResult.estimatedTotalHits,
      limit,
      offset,
    }, 200);
  }

  return c.json({
    results: results.map((row) => projectEntity(row, projection)),
    estimatedTotalHits: meiliResult.estimatedTotalHits,
    limit,
    offset,
  }, 200);
});

// --- POST /search/multi handler ---

searchRouter.openapi(multiSearchRoute, async (c) => {
  if (!isMeilisearchConfigured()) {
    throw new ApiError(503, "service_unavailable", "Search is not available (MEILI_URL not configured)");
  }

  const body = await parseJsonBody<{
    queries: Array<Record<string, unknown>>;
    view?: string;
    fields?: string;
    rel_limit?: number;
  }>(c);

  if (!Array.isArray(body.queries) || body.queries.length === 0) {
    throw new ApiError(400, "invalid_body", "queries must be a non-empty array");
  }
  if (body.queries.length > 10) {
    throw new ApiError(400, "invalid_body", "Maximum 10 queries per request");
  }

  const actor = c.get("actor");
  const projection = parseProjection(
    typeof body.view === "string" ? body.view : undefined,
    typeof body.fields === "string" ? body.fields : undefined,
  );

  // Build per-query Meilisearch requests
  const meiliQueries = body.queries.map((sq) => {
    const q = String(sq.q ?? "");
    if (!q) throw new ApiError(400, "invalid_body", "Each query must have a non-empty q field");

    const limit = Math.min(Math.max(1, Number(sq.limit) || 20), 50);
    const offset = Math.max(0, Number(sq.offset) || 0);

    const filters = buildSearchFilters({
      type: typeof sq.type === "string" ? sq.type : undefined,
      kind: typeof sq.kind === "string" ? sq.kind : undefined,
      spaceId: typeof sq.space_id === "string" ? sq.space_id : undefined,
    });

    return { q, filters, limit, offset };
  });

  // Execute all searches in one Meilisearch call
  const meiliResults = await multiSearchEntities(
    meiliQueries.map((mq) => ({
      query: mq.q,
      filter: mq.filters,
      limit: mq.limit,
      offset: mq.offset,
    })),
  );

  // Collect all unique IDs across all queries
  const allIds = new Set<string>();
  for (const mr of meiliResults) {
    for (const id of mr.ids) allIds.add(id);
  }

  if (allIds.size === 0) {
    return c.json({
      results: meiliQueries.map((mq, i) => ({
        q: mq.q,
        results: [],
        estimatedTotalHits: meiliResults[i].estimatedTotalHits,
        limit: mq.limit,
        offset: mq.offset,
      })),
    }, 200);
  }

  // Single Postgres fetch for all IDs + their space_ids
  const sql = createSql();
  const idArray = Array.from(allIds);
  const ctxQueries = setActorContext(sql, actor);
  const txResults = await sql.transaction([
    ...ctxQueries,
    sql.query(
      `SELECT * FROM entities WHERE id = ANY($1::text[])`,
      [idArray],
    ),
    sql.query(
      `SELECT entity_id, array_agg(space_id) AS space_ids FROM space_entities WHERE entity_id = ANY($1::text[]) GROUP BY entity_id`,
      [idArray],
    ),
  ]);

  const entityRows = txResults[ctxQueries.length] as Array<Record<string, unknown>>;
  const spaceRows = txResults[ctxQueries.length + 1] as Array<{ entity_id: string; space_ids: string[] }>;

  const spaceMap = new Map<string, string[]>();
  for (const row of spaceRows) {
    spaceMap.set(row.entity_id, row.space_ids);
  }

  const rowMap = new Map<string, Record<string, unknown>>();
  for (const row of entityRows) {
    row.space_ids = spaceMap.get(String(row.id)) ?? [];
    rowMap.set(String(row.id), row);
  }

  // Optionally fetch relationships for expanded view
  let relMap: Map<string, { items: unknown[]; truncated: boolean }> | null = null;
  if (projection.view === "expanded" && rowMap.size > 0) {
    const relLimit = Math.min(Number(body.rel_limit) || 5, 100);
    relMap = await fetchRelationshipContext(sql, actor, Array.from(rowMap.keys()), relLimit);
  }

  // Reassemble per-query results preserving relevance order
  const responseResults = meiliQueries.map((mq, i) => {
    const mr = meiliResults[i];
    const entities = mr.ids
      .map((id) => rowMap.get(id))
      .filter((row): row is Record<string, unknown> => row !== undefined);

    const projected = relMap
      ? entities.map((row) => {
          const ctx = relMap!.get(String(row.id));
          return {
            ...projectEntity(row, { view: "full", fields: null }),
            _relationships: ctx?.items ?? [],
            _relationships_truncated: ctx?.truncated ?? false,
          };
        })
      : entities.map((row) => projectEntity(row, projection));

    return {
      q: mq.q,
      results: projected,
      estimatedTotalHits: mr.estimatedTotalHits,
      limit: mq.limit,
      offset: mq.offset,
    };
  });

  return c.json({ results: responseResults }, 200);
});
