// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-line lookup for "every registered space and where it lives on
 * disk" — the input shape three different layers need:
 *
 *   - the agent tools' href rewriter (`href-rewrite.ts`),
 *   - the sync layer's cross-space link resolver (`html-links.ts`),
 *   - the reader's cross-space inverse rewriter (`reader.ts`).
 *
 * Returns a `Map<name → watch_dir>` so callers can do O(1) name
 * lookups and iterate watch_dirs in one shot.
 */

import { createSql } from "./sql.js";

export async function loadSpacesMap(): Promise<Map<string, string>> {
  const sql = createSql();
  const rows = (await sql`
    SELECT name, watch_dir FROM spaces WHERE watch_dir IS NOT NULL
  `) as unknown as Array<{ name: string; watch_dir: string }>;
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.name, row.watch_dir);
  return map;
}
