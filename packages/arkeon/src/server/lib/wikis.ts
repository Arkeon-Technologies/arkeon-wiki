// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiki listing as a library function.
 *
 * Hoisted out of `routes/wikis.ts` so the in-process agent runtime can
 * call it directly (no HTTP roundtrip) and the route handler stays a
 * thin wrapper. Behavior is the same as `GET /wikis`: same filters,
 * same shape, same ordering.
 */

import { ApiError } from "./errors.js";
import { createSql } from "./sql.js";

export type WikiSort = "updated_at" | "label";

export interface ListWikisOptions {
  /** Restrict to a single space. Omitted → all spaces. */
  space_id?: string;
  /** Filter on `properties.subject_type`. */
  subject_type?: string;
  /** Filter on `properties.status` (free-form; whatever the user puts
   *  in their frontmatter — e.g. `draft`, `review`, `published`). */
  status?: string;
  /** Case-insensitive substring match on `label`. "Baker Street" matches
   *  "221B Baker Street" or "Lower Baker Street". LIKE wildcards in the
   *  caller's input are escaped so `%foo` matches literally. */
  label_contains?: string;
  /** `updated_at` (default, newest first) or `label` (case-insensitive A→Z).
   *  Typed loosely as `string` so HTTP callers can pass an unvalidated query
   *  string directly; listWikis validates against SORT_COLUMNS and throws
   *  ApiError(400) on unknown values. Typed callers can pass a `WikiSort`
   *  literal — the union narrowing is enforced at the call site. */
  sort?: string;
  /** Attach an in/out link count per wiki. */
  include_counts?: boolean;
  /** Attach a top-level `relationships` array of all edges touching the
   *  matched wikis. Off by default since most callers don't need it. */
  include_relationships?: boolean;
  /** Default 100, capped at 10_000. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}

export interface WikiCounts {
  incoming_links: number;
  outgoing_links: number;
}

export interface WikiListRow {
  id: string;
  space_id: string;
  label: string;
  source_path: string;
  properties: Record<string, unknown> | string;
  created_at: string;
  updated_at: string;
  counts?: WikiCounts;
}

export interface WikiRelationshipRow {
  id: string;
  source_id: string;
  target_id: string;
  predicate: string;
  link_text: string | null;
  link_path: string | null;
}

export interface ListWikisResult {
  wikis: WikiListRow[];
  total: number;
  limit: number;
  offset: number;
  relationships?: WikiRelationshipRow[];
}

const SORT_COLUMNS: Record<WikiSort, string> = {
  updated_at: "e.updated_at DESC",
  label: "e.label COLLATE NOCASE ASC",
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;

export async function listWikis(opts: ListWikisOptions = {}): Promise<ListWikisResult> {
  const sortKey = opts.sort ?? "updated_at";
  const sortClause = SORT_COLUMNS[sortKey as WikiSort];
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
  const conditions: string[] = [`e.type = 'wiki'`];
  const params: unknown[] = [];

  if (opts.space_id) {
    params.push(opts.space_id);
    conditions.push(`e.space_id = ?`);
  }
  if (opts.subject_type) {
    params.push(opts.subject_type);
    conditions.push(`json_extract(e.properties, '$.subject_type') = ?`);
  }
  if (opts.status) {
    params.push(opts.status);
    conditions.push(`json_extract(e.properties, '$.status') = ?`);
  }
  if (opts.label_contains) {
    const escaped = opts.label_contains.replace(/[\\%_]/g, "\\$&");
    params.push(`%${escaped}%`);
    conditions.push(`e.label LIKE ? ESCAPE '\\' COLLATE NOCASE`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const wikis = (await sql.query(
    `SELECT e.id, e.space_id, e.label, e.source_path, e.properties,
            e.created_at, e.updated_at
     FROM entities e
     ${where}
     ORDER BY ${sortClause}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )) as unknown as WikiListRow[];

  const countResult = (await sql.query(
    `SELECT COUNT(*) AS total FROM entities e ${where}`,
    params,
  )) as unknown as Array<{ total: number }>;

  const result: ListWikisResult = {
    wikis,
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
  };

  const ids = wikis.map((w) => w.id);

  if (opts.include_counts && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const counts = (await sql.query(
      `SELECT
         e.id,
         (SELECT COUNT(*) FROM relationships r WHERE r.target_id = e.id) AS incoming_links,
         (SELECT COUNT(*) FROM relationships r WHERE r.source_id = e.id) AS outgoing_links
       FROM entities e
       WHERE e.id IN (${placeholders})`,
      ids,
    )) as unknown as Array<{
      id: string;
      incoming_links: number;
      outgoing_links: number;
    }>;
    const byId = new Map(counts.map((row) => [row.id, row]));
    for (const wiki of wikis) {
      const c = byId.get(wiki.id);
      wiki.counts = {
        incoming_links: c?.incoming_links ?? 0,
        outgoing_links: c?.outgoing_links ?? 0,
      };
    }
  }

  if (opts.include_relationships) {
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      result.relationships = (await sql.query(
        `SELECT id, source_id, target_id, predicate, link_text, link_path
         FROM relationships
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
        [...ids, ...ids],
      )) as unknown as WikiRelationshipRow[];
    } else {
      result.relationships = [];
    }
  }

  return result;
}
