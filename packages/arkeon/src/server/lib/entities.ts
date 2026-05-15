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
  /** Restrict to entities that have this tag key set. */
  has_tag?: string | null;
  /** Restrict to entities that do NOT have this tag key set. */
  not_has_tag?: string | null;
  /** Restrict to entities where tag `key` equals exactly `value`. */
  tag_equals?: { key: string; value: string } | null;
  /** Restrict to entities where this tag key's value equals the entity's
   *  current `source_hash`. Use for "processed at current content"
   *  queue gates (e.g. proposer's "editor has finished at the current
   *  source content" precondition). */
  tag_current?: string | null;
  /** Restrict to entities where this tag key is absent OR has a value
   *  that does NOT equal the entity's current `source_hash`. Use for
   *  "needs processing" queues — covers both unprocessed entities and
   *  ones whose content has changed since the last processing pass. */
  tag_outdated?: string | null;
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
  /** SHA-256 of the file content as of the last sync. Stable
   *  across reconciles unless the file's bytes change. Useful as a
   *  tag value for `editor.processed_hash` / `proposer.processed_hash`
   *  markers — pass it to `tag_entity` so content-change
   *  invalidation works automatically. */
  source_hash: string;
  properties: Record<string, unknown> | string;
  tags: Record<string, unknown> | string;
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
  // Tag filters use json_each rather than json_extract($.<key>) — the
  // dotted-namespace convention ("editor.processed") would otherwise be
  // parsed as a nested path. json_each iterates over the JSON object's
  // top-level entries, where `key` matches verbatim.
  if (opts.has_tag) {
    innerConditions.push(
      "EXISTS (SELECT 1 FROM json_each(e.tags) WHERE key = ?)",
    );
    innerParams.push(opts.has_tag);
  }
  if (opts.not_has_tag) {
    innerConditions.push(
      "NOT EXISTS (SELECT 1 FROM json_each(e.tags) WHERE key = ?)",
    );
    innerParams.push(opts.not_has_tag);
  }
  if (opts.tag_equals) {
    innerConditions.push(
      "EXISTS (SELECT 1 FROM json_each(e.tags) WHERE key = ? AND value = ?)",
    );
    innerParams.push(opts.tag_equals.key, opts.tag_equals.value);
  }
  // `tag_current` and `tag_outdated` compare the tag's value to the
  // entity's own `source_hash` column — purpose-built for processing
  // markers that need content-change invalidation. json_each walks
  // the tags bag once per row; the JOIN to source_hash is on the
  // same row, no subquery needed.
  if (opts.tag_current) {
    innerConditions.push(
      "EXISTS (SELECT 1 FROM json_each(e.tags) WHERE key = ? AND value = e.source_hash)",
    );
    innerParams.push(opts.tag_current);
  }
  if (opts.tag_outdated) {
    innerConditions.push(
      "NOT EXISTS (SELECT 1 FROM json_each(e.tags) WHERE key = ? AND value = e.source_hash)",
    );
    innerParams.push(opts.tag_outdated);
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
      e.space_name, e.source_path, e.type, e.label, e.source_hash,
      e.properties, e.tags, e.created_at, e.updated_at,
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
    source_hash: string;
    properties: Record<string, unknown> | string;
    tags: Record<string, unknown> | string;
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
        source_hash: row.source_hash,
        properties: row.properties,
        tags: row.tags,
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
  //
  // `target_path NOT LIKE '/%'` filters out cross-space red links
  // (canonical `/{otherSpace}/{path}` form). The writer is scoped
  // to its own space and shouldn't try to fulfill another space's
  // gaps; cross-space inbound edges still live in `relationships`
  // for graph queries, just not in the per-space writer queue.
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
      WHERE r.space_name = ?
        AND e.source_path IS NULL
        AND r.target_path NOT LIKE '/%'
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
    WHERE r.space_name = ?
      AND e.source_path IS NULL
      AND r.target_path NOT LIKE '/%'
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
 *
 * `inbound` is queried across **every** space — relationships rows in
 * other spaces that point at the canonical `/{this_space}/{path}`
 * cross-space form surface here as well, so consumers can answer
 * "who from any space cites this entity?" in one call. Each inbound
 * row carries `space_name` (the linker's space) so the consumer can
 * distinguish in-space citers from cross-space ones.
 */
export interface EntityDetail extends EntityListRow {
  outbound: Array<{ target_path: string; link_text: string | null }>;
  inbound: Array<{
    space_name: string;
    source_path: string;
    link_text: string | null;
  }>;
}

export async function getEntity(
  space_name: string,
  source_path: string,
): Promise<EntityDetail | null> {
  const sql = createSql();
  const rows = await sql`
    SELECT space_name, source_path, type, label, source_hash, properties, tags,
      created_at, updated_at,
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
  // Inbound includes two shapes of relationships row:
  //   - same-space:  (space_name = us, target_path = our path)
  //   - cross-space: (any space, target_path = "/{us}/{our path}")
  // Both come from a single SQL query so we don't pay the round-trip cost
  // of two separate selects.
  const crossTarget = `/${space_name}/${source_path}`;
  const inbound = await sql`
    SELECT space_name, source_path, link_text FROM relationships
    WHERE (space_name = ${space_name} AND target_path = ${source_path})
       OR target_path = ${crossTarget}
  `;

  return {
    space_name: row.space_name as string,
    source_path: row.source_path as string,
    type: row.type as EntityType,
    label: row.label as string | null,
    source_hash: row.source_hash as string,
    properties: row.properties as Record<string, unknown> | string,
    tags: row.tags as Record<string, unknown> | string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    last_edited_by: row.last_edited_by as string | null,
    outbound: outbound.map((r) => ({
      target_path: r.target_path as string,
      link_text: r.link_text as string | null,
    })),
    inbound: inbound.map((r) => ({
      space_name: r.space_name as string,
      source_path: r.source_path as string,
      link_text: r.link_text as string | null,
    })),
  };
}

// ── tag helpers ──────────────────────────────────────────────────────
//
// `tags` is agent-applied bookkeeping (e.g. `editor.processed_hash`),
// distinct from `properties` which is file-derived. Tags persist across
// `syncFile` reconciles — the UPDATE in sync.ts is explicit-column and
// never touches `tags` — and are cleared only when the entity row is
// deleted. The merge is done in SQL via json_patch so concurrent writes
// to different keys on the same entity don't race.
//
// We use json_patch + json_object rather than json_set('$.' || key) so
// dotted keys ("editor.processed") aren't misread as nested paths.
// RFC 7396 says a null value in the patch removes the key, which is how
// `deleteEntityTag` works.

/**
 * Idempotent upsert of a tag key/value on an entity. Returns true if a
 * row was matched (i.e. the entity exists), false otherwise.
 */
export async function setEntityTag(
  space_name: string,
  source_path: string,
  key: string,
  value: string,
): Promise<boolean> {
  const sql = createSql();
  const patch = JSON.stringify({ [key]: value });
  const result = await sql`
    UPDATE entities
    SET tags = json_patch(COALESCE(tags, '{}'), ${patch})
    WHERE space_name = ${space_name} AND source_path = ${source_path}
    RETURNING source_path
  `;
  return result.length > 0;
}

/**
 * Idempotent removal of a tag key on an entity. Returns true if a row
 * was matched.
 */
export async function deleteEntityTag(
  space_name: string,
  source_path: string,
  key: string,
): Promise<boolean> {
  const sql = createSql();
  // RFC 7396 merge-patch: null removes the key.
  const patch = JSON.stringify({ [key]: null });
  const result = await sql`
    UPDATE entities
    SET tags = json_patch(COALESCE(tags, '{}'), ${patch})
    WHERE space_name = ${space_name} AND source_path = ${source_path}
    RETURNING source_path
  `;
  return result.length > 0;
}
