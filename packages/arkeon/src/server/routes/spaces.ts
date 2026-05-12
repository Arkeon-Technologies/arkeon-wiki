// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { ApiError } from "../lib/errors.js";
import { startWatching } from "../lib/fs-watcher.js";

export const spacesRouter = new Hono<AppBindings>();

/**
 * POST /spaces — register a new space and start watching.
 * Body: { name: string, watch_dir: string }
 * Both fields required. Names are PKs, so a collision returns 409.
 */
spacesRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; watch_dir: string }>();
  if (!body.name || !body.watch_dir) {
    throw new ApiError(400, "validation_error", "name and watch_dir are required");
  }
  const sql = createSql();
  await sql`
    INSERT INTO spaces (name, watch_dir)
    VALUES (${body.name}, ${body.watch_dir})
  `;
  const space = { name: body.name, watch_dir: body.watch_dir };

  startWatching(space).catch((err) => {
    console.error(`[spaces] Failed to start watcher for "${body.name}":`, err.message);
  });

  return c.json(space, 201);
});

/** GET /spaces — list every registered space with its entity count. */
spacesRouter.get("/", async (c) => {
  const sql = createSql();
  const spaces = await sql`
    SELECT s.name, s.watch_dir, s.created_at,
           (SELECT COUNT(*) FROM entities e WHERE e.space_name = s.name) AS entity_count
    FROM spaces s
    ORDER BY s.created_at DESC
  `;
  return c.json({ spaces });
});

/** GET /spaces/:name — single space + its entity count. */
spacesRouter.get("/:name", async (c) => {
  const sql = createSql();
  const rows = await sql`
    SELECT s.name, s.watch_dir, s.created_at,
           (SELECT COUNT(*) FROM entities e WHERE e.space_name = s.name) AS entity_count
    FROM spaces s
    WHERE s.name = ${c.req.param("name")}
  `;
  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Space not found");
  }
  return c.json(rows[0]);
});
