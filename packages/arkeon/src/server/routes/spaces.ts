// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { generateUlid } from "../lib/ids.js";
import { ApiError } from "../lib/errors.js";
import { startWatching } from "../lib/fs-watcher.js";

export const spacesRouter = new Hono<AppBindings>();

// POST /spaces — register a new space and start watching
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

  const space = { id, name: body.name, watch_dir: body.watch_dir };

  // Start watching + reconcile in the background (don't block the response)
  startWatching(space).catch((err) => {
    console.error(`[spaces] Failed to start watcher for "${body.name}":`, err.message);
  });

  return c.json(space, 201);
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
