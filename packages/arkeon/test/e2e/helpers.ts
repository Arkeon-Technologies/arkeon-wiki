// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared e2e test helpers. Path-keyed shape: lookups are by
 * (space_name, source_path), not ULID.
 */

import { createSql } from "../../src/server/lib/sql.js";

export interface EntityRow {
  space_name: string;
  source_path: string;
  type: "wiki" | "file";
  label: string | null;
}

export async function getEntityByPath(
  spaceName: string,
  sourcePath: string,
): Promise<EntityRow | null> {
  const sql = createSql();
  const rows = await sql`
    SELECT space_name, source_path, type, label
    FROM entities
    WHERE space_name = ${spaceName} AND source_path = ${sourcePath}
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    space_name: row.space_name as string,
    source_path: row.source_path as string,
    type: row.type as "wiki" | "file",
    label: row.label as string | null,
  };
}

export async function waitForEntity(
  spaceName: string,
  sourcePath: string,
  timeoutMs = 5000,
): Promise<EntityRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entity = await getEntityByPath(spaceName, sourcePath);
    if (entity) return entity;
    await new Promise((r) => setTimeout(r, 100));
  }
  const final = await getEntityByPath(spaceName, sourcePath);
  if (!final) {
    throw new Error(
      `Timed out waiting for entity at ${sourcePath} in space ${spaceName}`,
    );
  }
  return final;
}

export async function countEntities(opts: {
  spaceName?: string;
  type?: "wiki" | "file";
} = {}): Promise<number> {
  const sql = createSql();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.spaceName) {
    conditions.push("space_name = ?");
    params.push(opts.spaceName);
  }
  if (opts.type) {
    conditions.push("type = ?");
    params.push(opts.type);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await sql.query(`SELECT COUNT(*) AS n FROM entities ${where}`, params);
  return Number(rows[0]?.n ?? 0);
}
