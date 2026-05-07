// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic entity listing — the read primitive that powers /entities and
 * the agent runtime's `list_entities` tool. One query covers wikis, source
 * files, and stubs; filters on type, frontmatter, link counts, recency,
 * and last-edit role.
 *
 * The query nests so the outer SELECT can filter on computed columns
 * (inbound/outbound counts, has_unresolved_outbound). Direct column
 * filters apply in the inner SELECT to avoid scanning more rows than
 * necessary.
 */

import { ApiError } from "./errors.js";
import { createSql } from "./sql.js";

export type EntityType = "wiki" | "file" | "stub";
export type EntitySort = "updated_at" | "label" | "inbound" | "outbound";

export interface ListEntitiesOptions {
  /** Restrict to a single space. Omitted → all spaces. */
  space_id?: string;
  /** Restrict to one or more entity types. Empty/undefined = any. */
  types?: EntityType[];
  /** Filter on `properties.subject_type` (frontmatter). */
  subject_type?: string;
  /** Filter on `properties.status` (frontmatter; free-form string). */
  status?: string;
  /** Case-insensitive substring match on `label`. */
  label_contains?: string;
  /** Inclusive lower bound on inbound relationship count. */
  inbound_min?: number;
  /** Inclusive upper bound on inbound relationship count. */
  inbound_max?: number;
  /** Inclusive lower bound on outbound relationship count. */
  outbound_min?: number;
  /** Inclusive upper bound on outbound relationship count. */
  outbound_max?: number;
  /** Filter to entities with at least one outbound link to a stub. */
  has_unresolved_outbound?: boolean;
  /** ISO timestamp; only entities with `updated_at >= this`. */
  updated_since?: string;
  /** Filter on the entity's most recent edit's `by_role` (via
   *  entity_latest_edit view from 004-edits-and-triggers.sql). */
  edited_by_role?: string;
  /** `updated_at` (default), `label`, `inbound`, or `outbound`. */
  sort?: string;
  /** Attach `counts.inbound` and `counts.outbound`. Default false. */
  include_counts?: boolean;
  /** Attach a top-level `relationships` array of all edges touching
   *  the matched entities. Default false. */
  include_relationships?: boolean;
  /** Default 100, capped at 10_000. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}

export interface EntityCounts {
  inbound: number;
  outbound: number;
}

export interface EntityListRow {
  id: string;
  space_id: string;
  type: EntityType;
  label: string;
  source_path: string;
  properties: Record<string, unknown> | string;
  created_at: string;
  updated_at: string;
  counts?: EntityCounts;
  /** True if any outbound edge from this entity targets a stub. */
  has_unresolved_outbound: boolean;
  /** Role/actor that made the most recent edit, or null if no edits
   *  have been recorded (e.g. stubs that were never written to). */
  last_edited_by: string | null;
}

export interface RelationshipRow {
  id: string;
  source_id: string;
  target_id: string;
  predicate: string;
  link_text: string | null;
  link_path: string | null;
}

export interface ListEntitiesResult {
  entities: EntityListRow[];
  total: number;
  limit: number;
  offset: number;
  relationships?: RelationshipRow[];
}

const SORT_COLUMNS: Record<EntitySort, string> = {
  updated_at: "updated_at DESC",
  label: "label COLLATE NOCASE ASC",
  inbound: "inbound DESC, updated_at DESC",
  outbound: "outbound DESC, updated_at DESC",
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;

export async function listEntities(
  opts: ListEntitiesOptions = {},
): Promise<ListEntitiesResult> {
  const sortKey = opts.sort ?? "updated_at";
  const sortClause = SORT_COLUMNS[sortKey as EntitySort];
  if (!sortClause) {
    throw new ApiError(
      400,
      "validation_error",
      `Invalid sort: must be one of ${Object.keys(SORT_COLUMNS).join(", ")}`,
    );
  }

  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = opts.offset ?? 0;

  const sql = createSql();

  // Inner-WHERE filters apply before the count subqueries fire, so they
  // only run for rows that survived the direct-column filter.
  const innerConditions: string[] = [];
  const innerParams: unknown[] = [];

  if (opts.space_id) {
    innerConditions.push("e.space_id = ?");
    innerParams.push(opts.space_id);
  }
  if (opts.types && opts.types.length > 0) {
    const placeholders = opts.types.map(() => "?").join(",");
    innerConditions.push(`e.type IN (${placeholders})`);
    innerParams.push(...opts.types);
  }
  if (opts.subject_type) {
    innerConditions.push("json_extract(e.properties, '$.subject_type') = ?");
    innerParams.push(opts.subject_type);
  }
  if (opts.status) {
    innerConditions.push("json_extract(e.properties, '$.status') = ?");
    innerParams.push(opts.status);
  }
  if (opts.label_contains) {
    const escaped = opts.label_contains.replace(/[\\%_]/g, "\\$&");
    innerConditions.push("e.label LIKE ? ESCAPE '\\' COLLATE NOCASE");
    innerParams.push(`%${escaped}%`);
  }
  if (opts.updated_since) {
    innerConditions.push("e.updated_at >= ?");
    innerParams.push(opts.updated_since);
  }

  // Last-edit filter via the entity_latest_edit view. The LEFT JOIN
  // is unconditional when this filter is present so the WHERE can
  // reference le.last_edited_by.
  let lastEditJoin = "";
  if (opts.edited_by_role) {
    lastEditJoin = "LEFT JOIN entity_latest_edit le ON le.entity_id = e.id";
    innerConditions.push("le.last_edited_by = ?");
    innerParams.push(opts.edited_by_role);
  }

  const innerWhere = innerConditions.length
    ? `WHERE ${innerConditions.join(" AND ")}`
    : "";

  const outerConditions: string[] = [];
  const outerParams: unknown[] = [];

  if (opts.inbound_min !== undefined) {
    outerConditions.push("inbound >= ?");
    outerParams.push(opts.inbound_min);
  }
  if (opts.inbound_max !== undefined) {
    outerConditions.push("inbound <= ?");
    outerParams.push(opts.inbound_max);
  }
  if (opts.outbound_min !== undefined) {
    outerConditions.push("outbound >= ?");
    outerParams.push(opts.outbound_min);
  }
  if (opts.outbound_max !== undefined) {
    outerConditions.push("outbound <= ?");
    outerParams.push(opts.outbound_max);
  }
  if (opts.has_unresolved_outbound !== undefined) {
    outerConditions.push("has_unresolved_outbound = ?");
    outerParams.push(opts.has_unresolved_outbound ? 1 : 0);
  }

  const outerWhere = outerConditions.length
    ? `WHERE ${outerConditions.join(" AND ")}`
    : "";

  const baseSelect = `
    SELECT
      e.id, e.space_id, e.type, e.label, e.source_path, e.properties,
      e.created_at, e.updated_at,
      (SELECT COUNT(*) FROM relationships r WHERE r.target_id = e.id) AS inbound,
      (SELECT COUNT(*) FROM relationships r WHERE r.source_id = e.id) AS outbound,
      EXISTS (
        SELECT 1 FROM relationships r
        JOIN entities t ON t.id = r.target_id
        WHERE r.source_id = e.id AND t.type = 'stub'
      ) AS has_unresolved_outbound,
      (SELECT le2.last_edited_by FROM entity_latest_edit le2
        WHERE le2.entity_id = e.id) AS last_edited_by
    FROM entities e
    ${lastEditJoin}
    ${innerWhere}
  `;

  const listSql = `
    SELECT * FROM (${baseSelect}) AS sub
    ${outerWhere}
    ORDER BY ${sortClause}
    LIMIT ? OFFSET ?
  `;

  interface RawEntityRow {
    id: string;
    space_id: string;
    type: EntityType;
    label: string;
    source_path: string;
    properties: Record<string, unknown> | string;
    created_at: string;
    updated_at: string;
    inbound: number;
    outbound: number;
    // SQLite's EXISTS yields 0/1 — coerce to boolean at the boundary.
    has_unresolved_outbound: number;
    last_edited_by: string | null;
  }

  const rawRows = (await sql.query(listSql, [
    ...innerParams,
    ...outerParams,
    limit,
    offset,
  ])) as unknown as RawEntityRow[];

  const countSql = `
    SELECT COUNT(*) AS total FROM (${baseSelect}) AS sub
    ${outerWhere}
  `;
  const countResult = (await sql.query(countSql, [
    ...innerParams,
    ...outerParams,
  ])) as unknown as Array<{ total: number }>;

  const result: ListEntitiesResult = {
    entities: rawRows.map((row) => {
      const entity: EntityListRow = {
        id: row.id,
        space_id: row.space_id,
        type: row.type,
        label: row.label,
        source_path: row.source_path,
        properties: row.properties,
        created_at: row.created_at,
        updated_at: row.updated_at,
        has_unresolved_outbound: Boolean(row.has_unresolved_outbound),
        last_edited_by: row.last_edited_by,
      };
      if (opts.include_counts) {
        entity.counts = {
          inbound: Number(row.inbound),
          outbound: Number(row.outbound),
        };
      }
      return entity;
    }),
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
  };

  if (opts.include_relationships) {
    const ids = rawRows.map((e) => e.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      result.relationships = (await sql.query(
        `SELECT id, source_id, target_id, predicate, link_text, link_path
         FROM relationships
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
        [...ids, ...ids],
      )) as unknown as RelationshipRow[];
    } else {
      result.relationships = [];
    }
  }

  return result;
}

/**
 * Parse a comma-separated list of entity types, validating each one.
 * Used by route handlers to coerce `?type=wiki,stub` into the typed array.
 * Returns `undefined` for empty/missing input (= no type filter).
 */
export function parseEntityTypes(raw: string | undefined): EntityType[] | undefined {
  if (!raw) return undefined;
  const out: EntityType[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (t !== "wiki" && t !== "file" && t !== "stub") {
      throw new ApiError(
        400,
        "validation_error",
        `Invalid entity type "${t}": must be one of wiki, file, stub`,
      );
    }
    out.push(t);
  }
  return out.length > 0 ? out : undefined;
}
