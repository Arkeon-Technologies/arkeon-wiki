// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic entity listing + red-link aggregation.
 *
 * The two writer-input queries live here:
 *   - `listEntities` — wikis and source files, filterable by type,
 *     inbound/outbound counts, recency, last-edit role, label substring.
 *     Powers `GET /{space}/entities` and the `list_entities` tool.
 *   - `listRedLinks` — link targets without a matching entity row,
 *     aggregated with demand count. Powers `GET /{space}/redlinks` and
 *     the `list_redlinks` tool. The query is structurally asymmetric
 *     to `listEntities` — red links live in `relationships.target_path`
 *     with no `entities` row by design (no placeholders), so they
 *     cannot be served by the listing endpoint no matter how it's
 *     filtered.
 */

import { ApiError } from "./errors.js";
import { createSql } from "./sql.js";

export type EntityType = "wiki" | "file";
export type EntitySort = "updated_at" | "label" | "inbound" | "outbound";

// All optional filters accept `null` as well as `undefined` — the AI SDK /
// OpenAI strict-mode pipeline materialises every schema field in the
// model's tool call, and `.nullable().optional()` zod fields surface as
// `null` for "absent". Internal checks use `!= null` to treat both alike.
export interface ListEntitiesOptions {
  /** Restrict to a single space by name. */
  space_name?: string | null;
  /** Restrict to one or more entity types. */
  types?: EntityType[] | null;
  /** Case-insensitive substring match on `label`. */
  label_contains?: string | null;
  /** Case-insensitive substring match on `source_path`. */
  path_contains?: string | null;
  inbound_min?: number | null;
  inbound_max?: number | null;
  outbound_min?: number | null;
  outbound_max?: number | null;
  /** ISO timestamp; only entities with `updated_at >= this`. */
  updated_since?: string | null;
  /** Filter on the entity's most recent edit's `by_role`. */
  edited_by_role?: string | null;
  sort?: string | null;
  include_counts?: boolean | null;
  limit?: number | null;
  offset?: number | null;
}

export interface EntityCounts {
  inbound: number;
  outbound: number;
}

export interface EntityListRow {
  space_name: string;
  source_path: string;
  type: EntityType;
  label: string | null;
  properties: Record<string, unknown> | string;
  created_at: string;
  updated_at: string;
  counts?: EntityCounts;
  /** Most recent edit's by_role, or null if no edits recorded yet. */
  last_edited_by: string | null;
}

export interface ListEntitiesResult {
  entities: EntityListRow[];
  total: number;
  limit: number;
  offset: number;
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

  const innerConditions: string[] = [];
  const innerParams: unknown[] = [];

  if (opts.space_name) {
    innerConditions.push("e.space_name = ?");
    innerParams.push(opts.space_name);
  }
  if (opts.types && opts.types.length > 0) {
    const placeholders = opts.types.map(() => "?").join(",");
    innerConditions.push(`e.type IN (${placeholders})`);
    innerParams.push(...opts.types);
  }
  if (opts.label_contains) {
    const escaped = opts.label_contains.replace(/[\\%_]/g, "\\$&");
    innerConditions.push("e.label LIKE ? ESCAPE '\\' COLLATE NOCASE");
    innerParams.push(`%${escaped}%`);
  }
  if (opts.path_contains) {
    const escaped = opts.path_contains.replace(/[\\%_]/g, "\\$&");
    innerConditions.push("e.source_path LIKE ? ESCAPE '\\' COLLATE NOCASE");
    innerParams.push(`%${escaped}%`);
  }
  if (opts.updated_since) {
    innerConditions.push("e.updated_at >= ?");
    innerParams.push(opts.updated_since);
  }
  if (opts.edited_by_role) {
    // Latest-edit filter via a correlated subquery against entity_edits.
    innerConditions.push(`
      (SELECT by_role FROM entity_edits ed
        WHERE ed.space_name = e.space_name AND ed.entity_path = e.source_path
        ORDER BY ed.at DESC LIMIT 1) = ?
    `);
    innerParams.push(opts.edited_by_role);
  }

  const innerWhere = innerConditions.length
    ? `WHERE ${innerConditions.join(" AND ")}`
    : "";

  const outerConditions: string[] = [];
  const outerParams: unknown[] = [];

  if (opts.inbound_min != null) {
    outerConditions.push("inbound >= ?");
    outerParams.push(opts.inbound_min);
  }
  if (opts.inbound_max != null) {
    outerConditions.push("inbound <= ?");
    outerParams.push(opts.inbound_max);
  }
  if (opts.outbound_min != null) {
    outerConditions.push("outbound >= ?");
    outerParams.push(opts.outbound_min);
  }
  if (opts.outbound_max != null) {
    outerConditions.push("outbound <= ?");
    outerParams.push(opts.outbound_max);
  }

  const outerWhere = outerConditions.length
    ? `WHERE ${outerConditions.join(" AND ")}`
    : "";

  const baseSelect = `
    SELECT
      e.space_name, e.source_path, e.type, e.label, e.properties,
      e.created_at, e.updated_at,
      (SELECT COUNT(*) FROM relationships r
        WHERE r.space_name = e.space_name AND r.target_path = e.source_path) AS inbound,
      (SELECT COUNT(*) FROM relationships r
        WHERE r.space_name = e.space_name AND r.source_path = e.source_path) AS outbound,
      (SELECT by_role FROM entity_edits ed
        WHERE ed.space_name = e.space_name AND ed.entity_path = e.source_path
        ORDER BY ed.at DESC LIMIT 1) AS last_edited_by
    FROM entities e
    ${innerWhere}
  `;

  const listSql = `
    SELECT * FROM (${baseSelect}) AS sub
    ${outerWhere}
    ORDER BY ${sortClause}
    LIMIT ? OFFSET ?
  `;

  interface RawEntityRow {
    space_name: string;
    source_path: string;
    type: EntityType;
    label: string | null;
    properties: Record<string, unknown> | string;
    created_at: string;
    updated_at: string;
    inbound: number;
    outbound: number;
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

  return {
    entities: rawRows.map((row) => {
      const entity: EntityListRow = {
        space_name: row.space_name,
        source_path: row.source_path,
        type: row.type,
        label: row.label,
        properties: row.properties,
        created_at: row.created_at,
        updated_at: row.updated_at,
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
}

export interface ListRedLinksOptions {
  space_name: string;
  /** Default 100. */
  limit?: number | null;
  offset?: number | null;
}

export interface RedLinkRow {
  target_path: string;
  demand: number;
  /** Last 3 source paths that link to this target (most recent first). */
  linked_from: string[];
}

export interface ListRedLinksResult {
  redlinks: RedLinkRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Link targets in this space that have no corresponding entity row.
 * Aggregated by target_path with `demand` (count) and `linked_from`
 * (the last 3 source_paths that pointed at this target). Sorted by
 * demand descending — the next thing the writer should fill in.
 */
export async function listRedLinks(
  opts: ListRedLinksOptions,
): Promise<ListRedLinksResult> {
  const limit = Math.min(opts.limit ?? 100, MAX_LIMIT);
  const offset = opts.offset ?? 0;

  const sql = createSql();

  // Single-pass aggregation: a CTE that pre-windows the linker rows
  // (newest 3 per target_path by rowid DESC) joined back to the
  // grouped-and-counted parent. The inner CTE produces (target_path,
  // source_path, rn) for every red-link edge in this space; the
  // outer SELECT groups by target_path, counts demand, and
  // GROUP_CONCATs the source_paths where rn <= 3.
  //
  // Replaces the previous N+1 form (aggregate query + per-row linkers
  // fetch). Same shape out, one round-trip instead of (1 + N).
  const redlinksSql = `
    WITH red AS (
      SELECT
        r.target_path,
        r.source_path,
        ROW_NUMBER() OVER (
          PARTITION BY r.target_path
          ORDER BY r.rowid DESC
        ) AS rn
      FROM relationships r
      LEFT JOIN entities e
        ON e.space_name = r.space_name AND e.source_path = r.target_path
      WHERE r.space_name = ? AND e.source_path IS NULL
    )
    SELECT
      target_path,
      COUNT(*) AS demand,
      GROUP_CONCAT(
        CASE WHEN rn <= 3 THEN source_path END,
        char(31)
      ) AS linked_from_concat
    FROM red
    GROUP BY target_path
    ORDER BY demand DESC, target_path ASC
    LIMIT ? OFFSET ?
  `;
  const aggRows = (await sql.query(redlinksSql, [opts.space_name, limit, offset])) as unknown as Array<{
    target_path: string;
    demand: number;
    linked_from_concat: string | null;
  }>;

  const totalSql = `
    SELECT COUNT(DISTINCT r.target_path) AS total
    FROM relationships r
    LEFT JOIN entities e
      ON e.space_name = r.space_name AND e.source_path = r.target_path
    WHERE r.space_name = ? AND e.source_path IS NULL
  `;
  const totalRow = (await sql.query(totalSql, [opts.space_name])) as unknown as Array<{
    total: number;
  }>;

  // GROUP_CONCAT result is delimited by char(31) (ASCII Unit Separator)
  // — chosen because no realistic source_path contains a control
  // character. NULLs from the CASE expression (rows where rn > 3) are
  // skipped by GROUP_CONCAT by design.
  const SEP = String.fromCharCode(31);
  const redlinks: RedLinkRow[] = aggRows.map((row) => ({
    target_path: row.target_path,
    demand: Number(row.demand),
    linked_from: row.linked_from_concat ? row.linked_from_concat.split(SEP) : [],
  }));

  return {
    redlinks,
    total: totalRow[0]?.total ?? 0,
    limit,
    offset,
  };
}

/**
 * Parse a comma-separated list of entity types, validating each one.
 * Used by route handlers to coerce `?type=wiki,file` into the typed array.
 */
export function parseEntityTypes(raw: string | null | undefined): EntityType[] | undefined {
  if (!raw) return undefined;
  const out: EntityType[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (t !== "wiki" && t !== "file") {
      throw new ApiError(
        400,
        "validation_error",
        `Invalid entity type "${t}": must be one of wiki, file`,
      );
    }
    out.push(t);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Fetch a single entity by (space_name, source_path) including outbound
 * relationships. Returns null if the entity does not exist.
 */
export interface EntityDetail extends EntityListRow {
  outbound: Array<{ target_path: string; link_text: string | null }>;
  inbound: Array<{ source_path: string; link_text: string | null }>;
}

export async function getEntity(
  space_name: string,
  source_path: string,
): Promise<EntityDetail | null> {
  const sql = createSql();
  const rows = await sql`
    SELECT space_name, source_path, type, label, properties, created_at, updated_at,
      (SELECT by_role FROM entity_edits ed
        WHERE ed.space_name = entities.space_name AND ed.entity_path = entities.source_path
        ORDER BY ed.at DESC LIMIT 1) AS last_edited_by
    FROM entities
    WHERE space_name = ${space_name} AND source_path = ${source_path}
  `;
  if (rows.length === 0) return null;
  const row = rows[0];

  const outbound = await sql`
    SELECT target_path, link_text FROM relationships
    WHERE space_name = ${space_name} AND source_path = ${source_path}
  `;
  const inbound = await sql`
    SELECT source_path, link_text FROM relationships
    WHERE space_name = ${space_name} AND target_path = ${source_path}
  `;

  return {
    space_name: row.space_name as string,
    source_path: row.source_path as string,
    type: row.type as EntityType,
    label: row.label as string | null,
    properties: row.properties as Record<string, unknown> | string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    last_edited_by: row.last_edited_by as string | null,
    outbound: outbound.map((r) => ({
      target_path: r.target_path as string,
      link_text: r.link_text as string | null,
    })),
    inbound: inbound.map((r) => ({
      source_path: r.source_path as string,
      link_text: r.link_text as string | null,
    })),
  };
}
