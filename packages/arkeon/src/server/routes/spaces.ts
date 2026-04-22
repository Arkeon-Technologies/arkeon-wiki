// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { generateUlid } from "../lib/ids.js";
import { ApiError } from "../lib/errors.js";

export const spacesRouter = new Hono<AppBindings>();

// POST /spaces — register a new space
spacesRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; watch_dir: string }>();

  if (!body.name || !body.watch_dir) {
    throw new ApiError(400, "validation_error", "name and watch_dir are required");
  }

  const id = generateUlid();
  const sql = createSql();

  await sql`
    INSERT INTO spaces (id, name, watch_dir)
    VALUES (${id}, ${body.name}, ${body.watch_dir})
  `;

  return c.json({ id, name: body.name, watch_dir: body.watch_dir }, 201);
});

// GET /spaces — list spaces
spacesRouter.get("/", async (c) => {
  const sql = createSql();
  const spaces = await sql`
    SELECT s.id, s.name, s.watch_dir, s.created_at,
           COUNT(e.id)::int AS entity_count
    FROM spaces s
    LEFT JOIN entities e ON e.space_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `;

  return c.json({ spaces });
});

// GET /spaces/:id — get a single space
spacesRouter.get("/:id", async (c) => {
  const sql = createSql();
  const rows = await sql`
    SELECT s.id, s.name, s.watch_dir, s.created_at,
           COUNT(e.id)::int AS entity_count
    FROM spaces s
    LEFT JOIN entities e ON e.space_id = s.id
    WHERE s.id = ${c.req.param("id")}
    GROUP BY s.id
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  return c.json(rows[0]);
});

// POST /spaces/:id/sync — trigger sync for a file or directory
spacesRouter.post("/:id/sync", async (c) => {
  const spaceId = c.req.param("id");
  const sql = createSql();

  const spaceRows = await sql`SELECT id, name, watch_dir FROM spaces WHERE id = ${spaceId}`;
  if (spaceRows.length === 0) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const space = spaceRows[0] as { id: string; name: string; watch_dir: string };
  const body = await c.req.json<{ files: string[] }>().catch(() => ({ files: [] as string[] }));

  if (!body.files || body.files.length === 0) {
    throw new ApiError(400, "validation_error", "files array is required");
  }

  // Dynamic import to avoid circular dependency
  const { syncFile } = await import("../lib/sync.js");

  const results = [];
  for (const file of body.files) {
    const result = await syncFile(space, file);
    results.push(result);
  }

  return c.json({ results });
});
