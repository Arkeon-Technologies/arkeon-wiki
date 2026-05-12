// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { ApiError } from "../lib/errors.js";
import { startWatching } from "../lib/fs-watcher.js";

export const spacesRouter = new Hono<AppBindings>();

/**
 * Space names are URL path segments (`/{space}/...`), so we restrict
 * them to ASCII alnum + `-` `_` `.`, starting with alnum. No slashes,
 * no whitespace, no `..` traversal. Matches the pattern of GitHub repo
 * names — broad enough to cover any reasonable directory basename while
 * keeping the URL semantics unambiguous.
 *
 * The leading-alnum rule keeps `.foo` / `-foo` out — neither would be
 * a directory traversal but both look like CLI flags or hidden files.
 */
const SPACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_SPACE_NAME_LEN = 100;

/**
 * POST /spaces — register a new space and start watching.
 * Body: { name: string, watch_dir: string }
 *
 * Both fields required. Names are PKs; collisions surface as 409 via
 * `mapDatabaseError` (SQLITE_CONSTRAINT_PRIMARYKEY → ApiError 409).
 * Names must match `[a-zA-Z0-9][a-zA-Z0-9._-]*` and be ≤100 chars.
 */
spacesRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; watch_dir: string }>();
  if (!body.name || !body.watch_dir) {
    throw new ApiError(400, "validation_error", "name and watch_dir are required");
  }
  if (body.name.length > MAX_SPACE_NAME_LEN) {
    throw new ApiError(
      400,
      "validation_error",
      `space name too long (max ${MAX_SPACE_NAME_LEN} chars)`,
    );
  }
  if (!SPACE_NAME_RE.test(body.name)) {
    throw new ApiError(
      400,
      "validation_error",
      `space name must match ${SPACE_NAME_RE.source} (ASCII alnum + - _ ., starting with alnum). ` +
        `Slashes, whitespace, and '..' would break the /{space}/... URL structure.`,
    );
  }
  if (body.name.includes("..")) {
    throw new ApiError(
      400,
      "validation_error",
      `space name cannot contain '..' (path-traversal guard).`,
    );
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
