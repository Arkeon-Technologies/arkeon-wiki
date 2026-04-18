// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Actor } from "../types";
import { setActorContext } from "./actor-context";
import type { SqlClient } from "./sql";

export interface RelationshipSummary {
  id: string;
  predicate: string;
  source_id: string;
  target_id: string;
  direction: "in" | "out";
  properties: Record<string, unknown>;
  counterpart: {
    id: string;
    kind: string;
    type: string;
    properties: { label: string | null; description: string | null };
  };
}

export interface RelationshipContext {
  items: RelationshipSummary[];
  truncated: boolean;
}

/**
 * Fetch relationship context for one or more entities.
 * Returns a Map from entity ID to its relationships + truncation flag.
 *
 * Fetches perEntityLimit+1 rows per entity to detect truncation without
 * a separate count query. Returns at most perEntityLimit items.
 */
export async function fetchRelationshipContext(
  sql: SqlClient,
  actor: Actor | null,
  entityIds: string[],
  perEntityLimit: number,
): Promise<Map<string, RelationshipContext>> {
  if (entityIds.length === 0) return new Map();

  const result = new Map<string, RelationshipContext>();
  for (const id of entityIds) result.set(id, { items: [], truncated: false });

  if (entityIds.length === 1) {
    const txResults = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT
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
            'properties', json_build_object('label', other.properties->>'label', 'description', other.properties->>'description')
          ) AS counterpart
        FROM relationship_edges re
        JOIN entities rel ON rel.id = re.id
        JOIN entities other ON other.id = CASE WHEN re.source_id = $1 THEN re.target_id ELSE re.source_id END
        WHERE re.source_id = $1 OR re.target_id = $1
        ORDER BY rel.created_at DESC
        LIMIT $2`,
        [entityIds[0], perEntityLimit + 1],
      ),
    ]);

    const rows = txResults[txResults.length - 1] as Array<Record<string, unknown>>;
    const truncated = rows.length > perEntityLimit;
    const items = rows.slice(0, perEntityLimit).map(toSummary);
    result.set(entityIds[0], { items, truncated });
    return result;
  }

  // Multiple entities: use UNION ALL to emit one row per anchor side,
  // then ROW_NUMBER to cap per entity. Fetch limit+1 to detect truncation.
  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `WITH expanded AS (
        SELECT
          rel.id, re.predicate, re.source_id, re.target_id, rel.properties,
          re.source_id AS anchor_id, 'out' AS direction,
          re.target_id AS counterpart_id, rel.created_at
        FROM relationship_edges re
        JOIN entities rel ON rel.id = re.id
        WHERE re.source_id = ANY($1::text[])
        UNION ALL
        SELECT
          rel.id, re.predicate, re.source_id, re.target_id, rel.properties,
          re.target_id AS anchor_id, 'in' AS direction,
          re.source_id AS counterpart_id, rel.created_at
        FROM relationship_edges re
        JOIN entities rel ON rel.id = re.id
        WHERE re.target_id = ANY($1::text[])
      ),
      ranked AS (
        SELECT
          e.*,
          json_build_object(
            'id', other.id, 'kind', other.kind, 'type', other.type,
            'properties', json_build_object('label', other.properties->>'label', 'description', other.properties->>'description')
          ) AS counterpart,
          ROW_NUMBER() OVER (PARTITION BY e.anchor_id ORDER BY e.created_at DESC) AS rn
        FROM expanded e
        JOIN entities other ON other.id = e.counterpart_id
      )
      SELECT id, predicate, source_id, target_id, properties, anchor_id, direction, counterpart, rn
      FROM ranked
      WHERE rn <= $2`,
      [entityIds, perEntityLimit + 1],
    ),
  ]);

  const rows = txResults[txResults.length - 1] as Array<Record<string, unknown>>;
  for (const row of rows) {
    const anchorId = String(row.anchor_id);
    const rn = Number(row.rn);
    const ctx = result.get(anchorId);
    if (!ctx) continue;

    if (rn > perEntityLimit) {
      ctx.truncated = true;
    } else {
      ctx.items.push(toSummary(row));
    }
  }

  return result;
}

function toSummary(row: Record<string, unknown>): RelationshipSummary {
  return {
    id: String(row.id),
    predicate: String(row.predicate),
    source_id: String(row.source_id),
    target_id: String(row.target_id),
    direction: row.direction as "in" | "out",
    properties: (row.properties ?? {}) as Record<string, unknown>,
    counterpart: row.counterpart as RelationshipSummary["counterpart"],
  };
}
