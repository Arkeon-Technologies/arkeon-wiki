// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Actor } from "../types";
import { setActorContext } from "./actor-context";
import { buildFilterSql } from "./filtering";
import type { SqlClient } from "./sql";

// ── Public types ──────────────────────────────────────────────────────

export interface TraverseNode {
  id: string;
  kind: "entity" | "relationship";
  type: string;
  properties: { label: string | null; description: string | null };
  created_at: string;
  updated_at: string;
  source_depth: number;
  target_depth: number | null;
  score: number;
}

export interface TraverseEdge {
  id: string;
  source_id: string;
  target_id: string;
  predicate: string;
  properties: Record<string, unknown>;
}

export interface TraverseResult {
  source_ids: string[];
  target_ids: string[] | null;
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  truncated: boolean;
}

export interface TraverseOptions {
  source: string;
  target?: string;
  hops: number;
  limit: number;
  predicates?: string[];
  query?: string;
  spaceId?: string;
}

// ── Constants ─────────────────────────────────────────────────────────

export const MAX_HOPS = 6;
export const MAX_LIMIT = 100;
const SET_CAP = 200;
const HOP_EDGE_LIMIT = 200;
const BFS_CEILING = 500;

/** Escape ILIKE wildcards so user input doesn't match everything. */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

// ── Set resolution ────────────────────────────────────────────────────

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

async function resolveEntitySet(
  sql: SqlClient,
  actor: Actor | null,
  filter: string,
  spaceId: string | null,
  maxResults: number,
): Promise<string[]> {
  // Fast path: single entity ID
  if (filter.startsWith("id:")) {
    const id = filter.slice(3);
    if (!ULID_RE.test(id)) return [];
    // Verify entity exists and actor can see it
    const results = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT id FROM entities WHERE id = $1 LIMIT 1`,
        [id],
      ),
    ]);
    const rows = results[results.length - 1] as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // Filter path: use buildFilterSql to resolve a set
  const params: unknown[] = [];
  const where: string[] = [];
  let nextIndex = 1;

  const filterResult = buildFilterSql(filter, params, nextIndex);
  where.push(...filterResult.sql);
  nextIndex = filterResult.nextIndex;

  if (spaceId) {
    params.push(spaceId);
    where.push(`id IN (SELECT entity_id FROM space_entities WHERE space_id = $${nextIndex})`);
    nextIndex += 1;
  }

  params.push(maxResults);
  const whereSql = where.join(" AND ");

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT id FROM entities WHERE ${whereSql} LIMIT $${nextIndex}`,
      params,
    ),
  ]);

  const rows = results[results.length - 1] as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// ── Hop expansion (shared by both modes) ──────────────────────────────

async function expandFrontier(
  sql: SqlClient,
  actor: Actor | null,
  frontier: string[],
  visited: Set<string>,
  predicates: string[] | null,
  spaceId: string | null,
): Promise<string[]> {
  if (frontier.length === 0) return [];

  const params: unknown[] = [frontier];
  let nextIndex = 2;

  const predicateClause = predicates
    ? (() => { params.push(predicates); return `AND re.predicate = ANY($${nextIndex++}::text[])`; })()
    : "";

  const spaceClause = spaceId
    ? (() => {
        params.push(spaceId);
        return `AND EXISTS (SELECT 1 FROM space_entities se WHERE se.space_id = $${nextIndex++} AND se.entity_id = neighbor.id)`;
      })()
    : "";

  params.push(HOP_EDGE_LIMIT);

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT DISTINCT neighbor_id FROM (
         -- Standard edge traversal: follow source_id/target_id
         SELECT
           CASE WHEN re.source_id = ANY($1::text[]) THEN re.target_id ELSE re.source_id END AS neighbor_id
         FROM relationship_edges re
         JOIN entities rel_ent ON rel_ent.id = re.id
         JOIN entities neighbor ON neighbor.id =
           CASE WHEN re.source_id = ANY($1::text[]) THEN re.target_id ELSE re.source_id END
         WHERE (re.source_id = ANY($1::text[]) OR re.target_id = ANY($1::text[]))
           ${predicateClause}
           ${spaceClause}
         UNION
         -- Relationship entity traversal: if frontier contains a relationship
         -- entity, follow to its source and target endpoints
         SELECT unnest(ARRAY[re2.source_id, re2.target_id]) AS neighbor_id
         FROM relationship_edges re2
         JOIN entities neighbor2 ON neighbor2.id = re2.source_id OR neighbor2.id = re2.target_id
         WHERE re2.id = ANY($1::text[])
       ) sub
       LIMIT $${nextIndex}`,
      params,
    ),
  ]);

  const rows = results[results.length - 1] as Array<{ neighbor_id: string }>;
  return rows
    .map((r) => String(r.neighbor_id))
    .filter((id) => !visited.has(id));
}

// ── Scoring ───────────────────────────────────────────────────────────

async function scoreNodes(
  sql: SqlClient,
  actor: Actor | null,
  candidateIds: string[],
  candidateDepths: number[],
  maxHops: number,
  query: string | null,
  limit: number,
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }> {
  if (candidateIds.length === 0) return { rows: [], truncated: false };

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `WITH candidates AS (
        SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS depth
      ),
      edge_counts AS (
        SELECT c.id, c.depth, COUNT(re.id)::int AS edge_count
        FROM candidates c
        LEFT JOIN relationship_edges re ON re.source_id = c.id OR re.target_id = c.id
        GROUP BY c.id, c.depth
      )
      SELECT
        ec.id, ec.depth,
        ROUND((
          LN(ec.edge_count + 1) * 2.0
          + CASE WHEN e.updated_at > NOW() - INTERVAL '7 days' THEN 3.0
                 WHEN e.updated_at > NOW() - INTERVAL '30 days' THEN 1.5
                 ELSE 0 END
          + (($3::int - ec.depth) * 1.5)
          + CASE WHEN $4::text IS NOT NULL AND (
                e.properties->>'label' ILIKE '%' || $4 || '%'
                OR e.properties->>'description' ILIKE '%' || $4 || '%'
                OR e.type ILIKE '%' || $4 || '%'
              ) THEN 5.0 ELSE 0 END
        )::numeric, 2) AS score,
        e.kind, e.type,
        json_build_object('label', e.properties->>'label', 'description', e.properties->>'description') AS properties,
        e.created_at, e.updated_at
      FROM edge_counts ec
      JOIN entities e ON e.id = ec.id
      ORDER BY score DESC
      LIMIT $5 + 1`,
      [candidateIds, candidateDepths, maxHops, query, limit],
    ),
  ]);

  const rows = results[results.length - 1] as Array<Record<string, unknown>>;
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

// ── Edge fetching ─────────────────────────────────────────────────────

async function fetchEdges(
  sql: SqlClient,
  actor: Actor | null,
  nodeIds: string[],
): Promise<TraverseEdge[]> {
  if (nodeIds.length === 0) return [];

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT re.id, re.source_id, re.target_id, re.predicate, rel.properties
       FROM relationship_edges re
       JOIN entities rel ON rel.id = re.id
       WHERE re.source_id = ANY($1::text[]) AND re.target_id = ANY($1::text[])`,
      [nodeIds],
    ),
  ]);

  const rows = results[results.length - 1] as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    source_id: String(row.source_id),
    target_id: String(row.target_id),
    predicate: String(row.predicate),
    properties: (row.properties ?? {}) as Record<string, unknown>,
  }));
}

// ── Main entry point ──────────────────────────────────────────────────

export async function fetchTraversal(
  sql: SqlClient,
  actor: Actor | null,
  options: TraverseOptions,
): Promise<TraverseResult> {
  const hops = Math.min(Math.max(options.hops, 1), MAX_HOPS);
  const limit = Math.min(Math.max(options.limit, 1), MAX_LIMIT);
  const predicates = options.predicates?.length ? options.predicates : null;
  const query = options.query ? escapeIlike(options.query) : null;
  const spaceId = options.spaceId ?? null;

  // ── Resolve source (and target if bridge mode) ──────────────────
  const sourceIds = await resolveEntitySet(sql, actor, options.source, spaceId, SET_CAP);
  if (sourceIds.length === 0) {
    return { source_ids: [], target_ids: null, nodes: [], edges: [], truncated: false };
  }

  const hasBridgeTarget = options.target !== undefined && options.target !== "";
  let targetIds: string[] | null = null;
  if (hasBridgeTarget) {
    targetIds = await resolveEntitySet(sql, actor, options.target!, spaceId, SET_CAP);
    if (targetIds.length === 0) {
      return { source_ids: sourceIds, target_ids: [], nodes: [], edges: [], truncated: false };
    }
  }

  // ── Bridge mode: bidirectional BFS ──────────────────────────────
  if (targetIds) {
    return bridgeTraverse(sql, actor, sourceIds, targetIds, hops, limit, predicates, query, spaceId);
  }

  // ── Neighborhood mode: one-sided BFS ────────────────────────────
  return neighborhoodTraverse(sql, actor, sourceIds, hops, limit, predicates, query, spaceId);
}

// ── Neighborhood mode ─────────────────────────────────────────────────

async function neighborhoodTraverse(
  sql: SqlClient,
  actor: Actor | null,
  sourceIds: string[],
  hops: number,
  limit: number,
  predicates: string[] | null,
  query: string | null,
  spaceId: string | null,
): Promise<TraverseResult> {
  const visited = new Map<string, number>(); // id → depth
  for (const id of sourceIds) visited.set(id, 0);
  let frontier = [...sourceIds];
  let hitCeiling = false;

  for (let d = 1; d <= hops; d++) {
    if (frontier.length === 0) break;

    const newNodes = await expandFrontier(
      sql, actor, frontier, new Set(visited.keys()), predicates, spaceId,
    );

    const nextFrontier: string[] = [];
    for (const nid of newNodes) {
      if (!visited.has(nid)) {
        visited.set(nid, d);
        nextFrontier.push(nid);
        if (visited.size >= BFS_CEILING) { hitCeiling = true; break; }
      }
    }
    frontier = nextFrontier;
    if (hitCeiling) break;
  }

  // Remove source nodes from candidates
  for (const id of sourceIds) visited.delete(id);

  const candidateIds = Array.from(visited.keys());
  const candidateDepths = candidateIds.map((id) => visited.get(id)!);

  const { rows, truncated } = await scoreNodes(
    sql, actor, candidateIds, candidateDepths, hops, query, limit,
  );

  const nodes: TraverseNode[] = rows.map((row) => ({
    id: String(row.id),
    kind: row.kind as "entity" | "relationship",
    type: String(row.type),
    properties: row.properties as { label: string | null; description: string | null },
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    source_depth: Number(row.depth),
    target_depth: null,
    score: Number(row.score),
  }));

  const allIds = [...sourceIds, ...nodes.map((n) => n.id)];
  const edges = await fetchEdges(sql, actor, allIds);

  return {
    source_ids: sourceIds,
    target_ids: null,
    nodes,
    edges,
    truncated: truncated || hitCeiling,
  };
}

// ── Bridge mode ───────────────────────────────────────────────────────

async function bridgeTraverse(
  sql: SqlClient,
  actor: Actor | null,
  sourceIds: string[],
  targetIds: string[],
  hops: number,
  limit: number,
  predicates: string[] | null,
  query: string | null,
  spaceId: string | null,
): Promise<TraverseResult> {
  // Track visited nodes from each side: id → depth from that side
  const sourceVisited = new Map<string, number>();
  const targetVisited = new Map<string, number>();
  for (const id of sourceIds) sourceVisited.set(id, 0);
  for (const id of targetIds) targetVisited.set(id, 0);

  let sourceFrontier = [...sourceIds];
  let targetFrontier = [...targetIds];
  let sourceHops = 0;
  let targetHops = 0;

  // Bridge nodes: discovered when a node exists in both visited sets
  const bridges = new Map<string, { sourceDepth: number; targetDepth: number }>();

  // Check initial overlap (source and target sets intersect)
  for (const id of sourceIds) {
    if (targetVisited.has(id)) {
      bridges.set(id, { sourceDepth: 0, targetDepth: targetVisited.get(id)! });
    }
  }

  const maxExpansions = hops;
  let expansions = 0;

  while (expansions < maxExpansions && bridges.size < limit) {
    // Pick the side with the smaller frontier to expand
    const expandSource =
      targetFrontier.length === 0 ||
      (sourceFrontier.length > 0 && sourceFrontier.length <= targetFrontier.length);

    if (expandSource && sourceFrontier.length === 0 && targetFrontier.length === 0) break;

    if (expandSource && sourceFrontier.length > 0) {
      sourceHops++;
      const newNodes = await expandFrontier(
        sql, actor, sourceFrontier, new Set(sourceVisited.keys()), predicates, spaceId,
      );

      const nextFrontier: string[] = [];
      for (const nid of newNodes) {
        if (!sourceVisited.has(nid)) {
          sourceVisited.set(nid, sourceHops);
          nextFrontier.push(nid);
          // Check if this node was already reached from the target side
          if (targetVisited.has(nid)) {
            bridges.set(nid, {
              sourceDepth: sourceHops,
              targetDepth: targetVisited.get(nid)!,
            });
          }
        }
      }
      sourceFrontier = nextFrontier;
      expansions++;
    } else if (targetFrontier.length > 0) {
      targetHops++;
      const newNodes = await expandFrontier(
        sql, actor, targetFrontier, new Set(targetVisited.keys()), predicates, spaceId,
      );

      const nextFrontier: string[] = [];
      for (const nid of newNodes) {
        if (!targetVisited.has(nid)) {
          targetVisited.set(nid, targetHops);
          nextFrontier.push(nid);
          // Check if this node was already reached from the source side
          if (sourceVisited.has(nid)) {
            bridges.set(nid, {
              sourceDepth: sourceVisited.get(nid)!,
              targetDepth: targetHops,
            });
          }
        }
      }
      targetFrontier = nextFrontier;
      expansions++;
    } else {
      break;
    }
  }

  if (bridges.size === 0) {
    return {
      source_ids: sourceIds,
      target_ids: targetIds,
      nodes: [],
      edges: [],
      truncated: false,
    };
  }

  // Score bridge nodes — depth = combined hops from both sides
  const bridgeIds = Array.from(bridges.keys());
  const bridgeDepths = bridgeIds.map((id) => {
    const b = bridges.get(id)!;
    return b.sourceDepth + b.targetDepth;
  });

  const { rows, truncated } = await scoreNodes(
    sql, actor, bridgeIds, bridgeDepths, hops, query, limit,
  );

  const nodes: TraverseNode[] = rows.map((row) => {
    const id = String(row.id);
    const bridge = bridges.get(id)!;
    return {
      id,
      kind: row.kind as "entity" | "relationship",
      type: String(row.type),
      properties: row.properties as { label: string | null; description: string | null },
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      source_depth: bridge.sourceDepth,
      target_depth: bridge.targetDepth,
      score: Number(row.score),
    };
  });

  // Fetch edges connecting source set + bridge nodes + target set
  const allIds = [
    ...sourceIds,
    ...nodes.map((n) => n.id),
    ...targetIds,
  ];
  const uniqueIds = [...new Set(allIds)];
  const edges = await fetchEdges(sql, actor, uniqueIds);

  return {
    source_ids: sourceIds,
    target_ids: targetIds,
    nodes,
    edges,
    truncated,
  };
}
