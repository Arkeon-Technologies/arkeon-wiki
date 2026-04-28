// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { ApiError } from "../lib/errors.js";
import { listWikis } from "../lib/wikis.js";

export const wikisRouter = new Hono<AppBindings>();

// GET /wikis — list wiki entities with frontmatter-aware filters.
// All filters and includes are documented on listWikis() in lib/wikis.ts.
wikisRouter.get("/", async (c) => {
  const include = (c.req.query("include") ?? "").split(",").map((s) => s.trim());
  const result = await listWikis({
    space_id: c.req.query("space_id"),
    subject_type: c.req.query("subject_type"),
    status: c.req.query("status"),
    label_prefix: c.req.query("label_prefix"),
    sort: c.req.query("sort"),
    include_relationships: include.includes("relationships"),
    include_counts: include.includes("counts"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
  });
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

  const { type: _type, ...wiki } = rows[0] as Record<string, unknown>;
  void _type;

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
