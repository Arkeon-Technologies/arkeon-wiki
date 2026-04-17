// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { createRouter } from "../lib/openapi";
import { fetchTraversal, MAX_HOPS, MAX_LIMIT } from "../lib/traverse";
import { fetchSpaceForActor } from "../lib/spaces";
import { createSql, withTransaction } from "../lib/sql";
import { setActorContext } from "../lib/actor-context";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import {
  EntityIdParam,
  GraphDataResponseSchema,
  TraverseResponseSchema,
  errorResponses,
  jsonContent,
  queryParam,
} from "../lib/schemas";

const traverseRoute = createRoute({
  method: "get",
  path: "/traverse",
  operationId: "graphTraverse",
  tags: ["Graph"],
  summary: "Traverse the graph from a source set, optionally finding bridges to a target set",
  description: [
    "Universal graph traversal primitive with two modes:",
    "",
    "**Neighborhood mode** (no target): BFS from source, returns top-K ranked nearby nodes.",
    "  Example: `?source=id:01ABC&hops=2&limit=20`",
    "",
    "**Bridge mode** (target specified): bidirectional BFS finds nodes connecting two entity sets.",
    "  Example: `?source=properties.work:Moby-Dick&target=properties.work:Crime and Punishment&hops=4`",
    "",
    "Source and target accept either `id:<ULID>` for a single entity, or the standard filter syntax",
    "(e.g. `type:concept,properties.work:Moby-Dick`). See GET /help for filter syntax.",
    "",
    "Ranking heuristic: connectivity (edge count) + recency + proximity (fewer hops = higher) + optional query-term boost.",
  ].join("\n"),
  "x-arke-auth": "optional",
  "x-arke-related": [
    "GET /wiki/{id}",
    "GET /wiki/{id}/relationships",
    "GET /search",
  ],
  "x-arke-rules": [
    "Source and target entities filtered by your classification clearance",
    "Traversal follows edges in both directions",
    "Limits are global, not per-hop",
    "Results ranked by connectivity + recency + proximity + query relevance",
    "If space_id is provided, traversal is constrained to entities within that space",
    "Bridge mode uses bidirectional BFS for efficiency at higher hop counts",
  ],
  request: {
    query: z.object({
      source: queryParam(
        "source",
        z.string(),
        "Source entity filter. Use id:<ULID> for a single entity, or filter syntax (e.g. type:concept,properties.work:Moby-Dick)",
      ),
      target: queryParam(
        "target",
        z.string().optional(),
        "Target entity filter (enables bridge mode). Same syntax as source.",
      ),
      hops: queryParam(
        "hops",
        z.coerce.number().int().min(1).max(MAX_HOPS).optional(),
        `Max edge traversals (default 2, max ${MAX_HOPS})`,
      ),
      limit: queryParam(
        "limit",
        z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
        `Max nodes to return (default 20, max ${MAX_LIMIT})`,
      ),
      predicates: queryParam(
        "predicates",
        z.string().optional(),
        "Comma-separated edge predicate filter (e.g. related_to,influenced_by)",
      ),
      q: queryParam(
        "q",
        z.string().optional(),
        "Optional query terms — matching nodes get a ranking boost",
      ),
      space_id: queryParam(
        "space_id",
        EntityIdParam.optional(),
        "Constrain traversal to entities within this space",
      ),
    }),
  },
  responses: {
    200: {
      description: "Traversal result: ranked nodes and connecting edges",
      content: jsonContent(TraverseResponseSchema),
    },
    ...errorResponses([400, 403, 404]),
  },
});

export const graphRouter = createRouter();

graphRouter.openapi(traverseRoute, async (c) => {
  const actor = c.get("actor") ?? null;
  const source = c.req.query("source");
  if (!source) {
    throw new ApiError(400, "missing_required_field", "source query parameter is required");
  }

  const target = c.req.query("target") || undefined;
  const hops = Number(c.req.query("hops") ?? 2);
  const limit = Number(c.req.query("limit") ?? 20);
  const predicatesRaw = c.req.query("predicates");
  const predicates = predicatesRaw ? predicatesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const query = c.req.query("q") || undefined;
  const spaceId = c.req.query("space_id") || undefined;

  // Validate space if provided
  if (spaceId) {
    const space = await fetchSpaceForActor(actor, spaceId);
    if (!space) {
      throw new ApiError(404, "not_found", "Space not found");
    }
  }

  const sql = createSql();
  const result = await fetchTraversal(sql, actor, {
    source,
    target,
    hops,
    limit,
    predicates,
    query,
    spaceId,
  });

  if (result.source_ids.length === 0) {
    throw new ApiError(404, "not_found", "No entities match the source filter");
  }

  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// GET /graph/data — lightweight bulk graph data for visualization
// ---------------------------------------------------------------------------

const GRAPH_DATA_MAX_LIMIT = 50_000;

const graphDataRoute = createRoute({
  method: "get",
  path: "/data",
  operationId: "getGraphData",
  tags: ["Graph"],
  summary: "Bulk graph data for visualization — minimal node and edge payloads in a single response",
  description: [
    "Returns lightweight node and edge data suitable for rendering large graphs.",
    "Nodes include only id, label, type, and space memberships.",
    "Edges include only id, source_id, target_id, and predicate.",
    "Full entity details should be loaded on-demand via GET /wiki/{id}.",
  ].join("\n"),
  "x-arke-auth": "optional",
  "x-arke-related": [
    "GET /wiki/{id}",
    "GET /graph/traverse",
  ],
  "x-arke-rules": [
    "Nodes filtered by your classification clearance",
    "Edges only included when both endpoints are in the result set",
    "Collection edges are excluded",
  ],
  request: {
    query: z.object({
      space_id: queryParam(
        "space_id",
        EntityIdParam.optional(),
        "Filter to entities within this space",
      ),
      limit: queryParam(
        "limit",
        z.coerce.number().int().min(1).max(GRAPH_DATA_MAX_LIMIT).optional(),
        `Max nodes to return (default 10000, max ${GRAPH_DATA_MAX_LIMIT})`,
      ),
      cursor: queryParam(
        "cursor",
        z.string().optional(),
        "Pagination cursor from a previous response",
      ),
    }),
  },
  responses: {
    200: {
      description: "Graph nodes and edges",
      content: jsonContent(GraphDataResponseSchema),
    },
    ...errorResponses([400, 403]),
  },
});

graphRouter.openapi(graphDataRoute, async (c) => {
  const actor = c.get("actor") ?? null;
  const spaceId = c.req.query("space_id") || undefined;
  const limit = Number(c.req.query("limit") ?? 10_000);
  const cursorRaw = c.req.query("cursor") || undefined;
  const cursor = decodeCursor(cursorRaw);

  if (spaceId) {
    const space = await fetchSpaceForActor(actor, spaceId);
    if (!space) {
      throw new ApiError(404, "not_found", "Space not found");
    }
  }

  const result = await withTransaction(async (tx) => {
    // Set RLS context
    for (const q of setActorContext(tx, actor)) {
      await q;
    }

    // Build nodes query
    const params: unknown[] = [];
    let paramIdx = 1;

    let where = "WHERE e.kind = 'entity'";
    if (spaceId) {
      params.push(spaceId);
      where += ` AND e.id IN (SELECT entity_id FROM space_entities WHERE space_id = $${paramIdx})`;
      paramIdx++;
    }
    if (cursor) {
      params.push(cursor.t, cursor.i);
      where += ` AND (e.updated_at, e.id) < ($${paramIdx}, $${paramIdx + 1})`;
      paramIdx += 2;
    }
    params.push(limit + 1);

    const nodesRows = await tx.query(
      `SELECT
        e.id,
        COALESCE(e.properties->>'label', e.properties->>'title', e.properties->>'name', e.type) AS label,
        e.type,
        (SELECT COALESCE(array_agg(se.space_id), '{}') FROM space_entities se WHERE se.entity_id = e.id) AS space_ids,
        e.updated_at
      FROM entities e
      ${where}
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT $${paramIdx}`,
      params,
    );

    // Determine pagination
    const hasMore = nodesRows.length > limit;
    const pageRows = hasMore ? nodesRows.slice(0, limit) : nodesRows;

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor({ t: last.updated_at as string, i: last.id as string });
    }

    const nodes = pageRows.map((r) => ({
      id: r.id as string,
      label: r.label as string,
      type: r.type as string,
      space_ids: (r.space_ids as string[]) || [],
    }));

    // Fetch edges between returned nodes
    const nodeIds = nodes.map((n) => n.id);
    let edges: Array<{ id: string; source_id: string; target_id: string; predicate: string }> = [];

    if (nodeIds.length > 0) {
      const edgeRows = await tx.query(
        `SELECT re.id, re.source_id, re.target_id, re.predicate
        FROM relationship_edges re
        JOIN entities rel_e ON rel_e.id = re.id
        WHERE re.source_id = ANY($1)
          AND re.target_id = ANY($1)
          AND re.predicate != 'collection'`,
        [nodeIds],
      );

      edges = edgeRows.map((r) => ({
        id: r.id as string,
        source_id: r.source_id as string,
        target_id: r.target_id as string,
        predicate: r.predicate as string,
      }));
    }

    return { nodes, edges, cursor: nextCursor };
  });

  return c.json(result, 200);
});
