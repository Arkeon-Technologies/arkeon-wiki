// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared e2e test helpers.
 *
 * Direct-SQLite helpers for tests. Pre-/entities, the HTTP API only
 * surfaced wikis, so these helpers were the only way to assert on source
 * files. They remain useful for "look at the row directly" assertions
 * that don't want to go through the route layer.
 */

import { createSql } from "../../src/server/lib/sql.js";

export interface EntityRow {
  id: string;
  space_id: string;
  type: "wiki" | "file" | "stub";
  label: string;
  source_path: string;
}

/**
 * Look up an entity by source_path within a space. Returns null if no row
 * exists yet (callers typically poll because the watcher is async).
 */
export async function getEntityBySourcePath(
  spaceId: string,
  sourcePath: string,
): Promise<EntityRow | null> {
  const sql = createSql();
  const rows = await sql`
    SELECT id, space_id, type, label, source_path
    FROM entities
    WHERE space_id = ${spaceId} AND source_path = ${sourcePath}
  `;
  return (rows[0] as EntityRow | undefined) ?? null;
}

/** Poll until an entity with the given source_path exists, or timeout. */
export async function waitForEntityBySourcePath(
  spaceId: string,
  sourcePath: string,
  timeoutMs = 5000,
): Promise<EntityRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entity = await getEntityBySourcePath(spaceId, sourcePath);
    if (entity) return entity;
    await new Promise((r) => setTimeout(r, 200));
  }
  const final = await getEntityBySourcePath(spaceId, sourcePath);
  if (!final) {
    throw new Error(
      `Timed out waiting for entity at ${sourcePath} in space ${spaceId}`,
    );
  }
  return final;
}

/** Count rows in the entities table (filterable by type / space). */
export async function countEntities(opts: {
  spaceId?: string;
  type?: "wiki" | "file" | "stub";
} = {}): Promise<number> {
  const sql = createSql();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.spaceId) {
    conditions.push("space_id = ?");
    params.push(opts.spaceId);
  }
  if (opts.type) {
    conditions.push("type = ?");
    params.push(opts.type);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await sql.query(
    `SELECT COUNT(*) AS n FROM entities ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
