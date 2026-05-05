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
    label_contains: c.req.query("label_contains"),
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

// GET /wikis/:id/history — chronological audit log of edits to this wiki.
//
// Returns rows from entity_edits ordered newest-first. Useful for the
// synthesizer (which polls for recent edits to drive its work) and for
// human inspection of who-touched-what.
//
// Query params:
//   limit  — max rows to return (default 50, max 500)
//   offset — pagination offset
//   since  — ISO-8601 timestamp; only return edits at-or-after this
//   role   — restrict to edits made by a specific by_role
wikisRouter.get("/:id/history", async (c) => {
  const id = c.req.param("id");
  const sql = createSql();

  // Confirm the entity exists (otherwise 404 rather than empty array).
  const entity = await sql`
    SELECT id FROM entities WHERE id = ${id} AND type = 'wiki'
  `;
  if (entity.length === 0) {
    throw new ApiError(404, "not_found", "Wiki not found");
  }

  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 50), 1),
    500,
  );
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const since = c.req.query("since");
  const role = c.req.query("role");

  // Build the WHERE clause incrementally. The postgres-style
  // tagged template SQL helper this codebase uses doesn't support
  // dynamic AND-chains cleanly, so we branch on the four cases.
  let rows;
  if (since && role) {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id} AND at >= ${since} AND by_role = ${role}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (since) {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id} AND at >= ${since}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (role) {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id} AND by_role = ${role}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return c.json({ entity_id: id, edits: rows });
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
