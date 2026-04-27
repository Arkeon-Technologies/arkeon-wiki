// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { ApiError } from "../lib/errors.js";

export const wikisRouter = new Hono<AppBindings>();

const SORT_COLUMNS: Record<string, string> = {
  updated_at: "e.updated_at DESC",
  label: "e.label COLLATE NOCASE ASC",
};

// GET /wikis — list wiki entities with frontmatter-aware filters
//
// Query params:
//   space_id          — filter by space
//   subject_type      — filter on properties.subject_type
//   status            — filter on properties.status (placeholder|published|...)
//   label_prefix      — case-insensitive prefix match on label
//   has_contributions — "true" → only wikis with pending contributions
//   sort              — updated_at (default) | label
//   include           — comma-separated: relationships, counts
//   limit             — default 100, max 10000
//   offset            — pagination offset
wikisRouter.get("/", async (c) => {
  const spaceId = c.req.query("space_id");
  const subjectType = c.req.query("subject_type");
  const status = c.req.query("status");
  const labelPrefix = c.req.query("label_prefix");
  const hasContributions = c.req.query("has_contributions") === "true";
  const sortKey = c.req.query("sort") ?? "updated_at";
  const include = (c.req.query("include") ?? "").split(",").map((s) => s.trim());
  const includeRelationships = include.includes("relationships");
  const includeCounts = include.includes("counts");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 10_000);
  const offset = Number(c.req.query("offset") ?? 0);

  const sortClause = SORT_COLUMNS[sortKey];
  if (!sortClause) {
    throw new ApiError(
      400,
      "validation_error",
      `Invalid sort: must be one of ${Object.keys(SORT_COLUMNS).join(", ")}`,
    );
  }

  const sql = createSql();
  const conditions: string[] = [`e.type = 'wiki'`];
  const params: unknown[] = [];

  if (spaceId) {
    params.push(spaceId);
    conditions.push(`e.space_id = ?`);
  }
  if (subjectType) {
    params.push(subjectType);
    conditions.push(`json_extract(e.properties, '$.subject_type') = ?`);
  }
  if (status) {
    params.push(status);
    conditions.push(`json_extract(e.properties, '$.status') = ?`);
  }
  if (labelPrefix) {
    params.push(`${labelPrefix}%`);
    conditions.push(`e.label LIKE ? COLLATE NOCASE`);
  }
  if (hasContributions) {
    conditions.push(
      `EXISTS (SELECT 1 FROM contributions c
               WHERE c.wiki_id = e.id AND c.consumed_at IS NULL)`,
    );
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const wikis = await sql.query(
    `SELECT e.id, e.space_id, e.label, e.source_path, e.properties,
            e.created_at, e.updated_at
     FROM entities e
     ${where}
     ORDER BY ${sortClause}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const countResult = await sql.query(
    `SELECT COUNT(*) AS total FROM entities e ${where}`,
    params,
  );

  const result: Record<string, unknown> = {
    wikis,
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
  };

  const ids = wikis.map((w) => w.id as string);

  if (includeCounts && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const counts = await sql.query(
      `SELECT
         e.id,
         (SELECT COUNT(*) FROM contributions c
          WHERE c.wiki_id = e.id AND c.consumed_at IS NULL) AS contributions_pending,
         (SELECT COUNT(*) FROM relationships r WHERE r.target_id = e.id) AS incoming_links,
         (SELECT COUNT(*) FROM relationships r WHERE r.source_id = e.id) AS outgoing_links
       FROM entities e
       WHERE e.id IN (${placeholders})`,
      ids,
    );
    const byId = new Map(counts.map((row) => [row.id as string, row]));
    for (const wiki of wikis) {
      const c = byId.get(wiki.id as string);
      wiki.counts = {
        contributions_pending: c?.contributions_pending ?? 0,
        incoming_links: c?.incoming_links ?? 0,
        outgoing_links: c?.outgoing_links ?? 0,
      };
    }
  }

  if (includeRelationships) {
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      result.relationships = await sql.query(
        `SELECT id, source_id, target_id, predicate, link_text, link_path
         FROM relationships
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
        [...ids, ...ids],
      );
    } else {
      result.relationships = [];
    }
  }

  return c.json(result);
});

// GET /wikis/:id — wiki properties + relationships, optional body content.
//
// Query params:
//   include — comma-separated: "content" reads the file from disk
wikisRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const include = (c.req.query("include") ?? "").split(",").map((s) => s.trim());
  const includeContent = include.includes("content");

  const sql = createSql();

  const rows = await sql`
    SELECT e.id, e.space_id, e.type, e.label, e.source_path, e.properties,
           e.created_at, e.updated_at
    FROM entities e
    WHERE e.id = ${id} AND e.type = 'wiki'
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Wiki not found");
  }

  const wiki = rows[0] as Record<string, unknown>;
  delete wiki.type;

  const outgoing = await sql`
    SELECT r.id, r.target_id, r.predicate, r.link_text, r.link_path,
           t.label AS target_label, t.type AS target_type, t.source_path AS target_source_path
    FROM relationships r
    JOIN entities t ON t.id = r.target_id
    WHERE r.source_id = ${id}
    ORDER BY r.created_at
  `;

  const incoming = await sql`
    SELECT r.id, r.source_id, r.predicate, r.link_text, r.link_path,
           s.label AS source_label, s.type AS source_type, s.source_path AS source_source_path
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    WHERE r.target_id = ${id}
    ORDER BY r.created_at
  `;

  const result: Record<string, unknown> = {
    ...wiki,
    relationships: { outgoing, incoming },
  };

  if (includeContent && wiki.source_path) {
    const spaceRows = await sql`
      SELECT watch_dir FROM spaces WHERE id = ${wiki.space_id}
    `;
    if (spaceRows.length > 0 && spaceRows[0].watch_dir) {
      const absPath = join(spaceRows[0].watch_dir as string, wiki.source_path as string);
      if (existsSync(absPath)) {
        try {
          result.content = readFileSync(absPath, "utf-8");
        } catch {
          result.content = null;
        }
      } else {
        result.content = null;
      }
    }
  }

  return c.json(result);
});

// DELETE /wikis/:id — remove a wiki entity
wikisRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const sql = createSql();

  const rows = await sql`
    DELETE FROM entities WHERE id = ${id} AND type = 'wiki'
    RETURNING id, label
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Wiki not found");
  }

  return c.json({ deleted: true, id, label: rows[0].label });
});
