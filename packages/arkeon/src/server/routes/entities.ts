// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { ApiError } from "../lib/errors.js";

export const entitiesRouter = new Hono<AppBindings>();

// GET /entities — list entities with optional filtering
//
// Query params:
//   space_id    — filter by space
//   type        — filter by type (wiki, file)
//   limit       — max results (default 100, max 10000)
//   offset      — pagination offset
//   include     — comma-separated: "relationships" adds a top-level
//                 relationships array (all edges for matched entities)
entitiesRouter.get("/", async (c) => {
  const spaceId = c.req.query("space_id");
  const type = c.req.query("type");
  const include = (c.req.query("include") ?? "").split(",").map((s) => s.trim());
  const includeRelationships = include.includes("relationships");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 10_000);
  const offset = Number(c.req.query("offset") ?? 0);

  const sql = createSql();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (spaceId) {
    params.push(spaceId);
    conditions.push(`e.space_id = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`e.type = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const entities = await sql.query(
    `SELECT e.id, e.space_id, e.type, e.label, e.source_path, e.properties,
            e.created_at, e.updated_at
     FROM entities e
     ${where}
     ORDER BY e.updated_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  const countResult = await sql.query(
    `SELECT COUNT(*)::int AS total FROM entities e ${where}`,
    params,
  );

  const result: Record<string, unknown> = {
    entities,
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
  };

  if (includeRelationships) {
    // Fetch all relationships for the matched entities
    const entityIds = entities.map((e: Record<string, unknown>) => e.id as string);
    if (entityIds.length > 0) {
      const relationships = await sql`
        SELECT id, source_id, target_id, predicate, link_text, link_path
        FROM relationships
        WHERE source_id = ANY(${entityIds}) OR target_id = ANY(${entityIds})
      `;
      result.relationships = relationships;
    } else {
      result.relationships = [];
    }
  }

  return c.json(result);
});

// GET /entities/:id — get entity properties + relationships
//
// Query params:
//   include — comma-separated: "content" reads the file from disk
//             and adds a `content` field to the response
entitiesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const include = (c.req.query("include") ?? "").split(",").map((s) => s.trim());
  const includeContent = include.includes("content");

  const sql = createSql();

  const rows = await sql`
    SELECT e.id, e.space_id, e.type, e.label, e.source_path, e.properties,
           e.created_at, e.updated_at
    FROM entities e
    WHERE e.id = ${id}
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  const entity = rows[0] as Record<string, unknown>;

  // Fetch outgoing relationships (this entity → others)
  const outgoing = await sql`
    SELECT r.id, r.target_id, r.predicate, r.link_text, r.link_path,
           t.label AS target_label, t.type AS target_type, t.source_path AS target_source_path
    FROM relationships r
    JOIN entities t ON t.id = r.target_id
    WHERE r.source_id = ${id}
    ORDER BY r.created_at
  `;

  // Fetch incoming relationships (others → this entity)
  const incoming = await sql`
    SELECT r.id, r.source_id, r.predicate, r.link_text, r.link_path,
           s.label AS source_label, s.type AS source_type, s.source_path AS source_source_path
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    WHERE r.target_id = ${id}
    ORDER BY r.created_at
  `;

  const result: Record<string, unknown> = {
    ...entity,
    relationships: {
      outgoing,
      incoming,
    },
  };

  // Read content from disk if requested
  if (includeContent && entity.source_path) {
    const spaceRows = await sql`
      SELECT watch_dir FROM spaces WHERE id = ${entity.space_id}
    `;
    if (spaceRows.length > 0 && spaceRows[0].watch_dir) {
      const absPath = join(spaceRows[0].watch_dir as string, entity.source_path as string);
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

// DELETE /entities/:id — remove entity
entitiesRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const sql = createSql();

  const rows = await sql`
    DELETE FROM entities WHERE id = ${id} RETURNING id, label
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  return c.json({ deleted: true, id, label: rows[0].label });
});
