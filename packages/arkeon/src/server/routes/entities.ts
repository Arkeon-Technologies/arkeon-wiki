// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { ApiError } from "../lib/errors.js";

export const entitiesRouter = new Hono<AppBindings>();

// GET /entities — list entities with optional filtering
entitiesRouter.get("/", async (c) => {
  const spaceId = c.req.query("space_id");
  const type = c.req.query("type");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
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

  // Get total count
  const countResult = await sql.query(
    `SELECT COUNT(*)::int AS total FROM entities e ${where}`,
    params,
  );

  return c.json({
    entities,
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
  });
});

// GET /entities/:id — get entity properties + relationships (no content)
entitiesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const sql = createSql();

  const rows = await sql`
    SELECT id, space_id, type, label, source_path, properties, created_at, updated_at
    FROM entities
    WHERE id = ${id}
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  const entity = rows[0];

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

  return c.json({
    ...entity,
    relationships: {
      outgoing,
      incoming,
    },
  });
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
