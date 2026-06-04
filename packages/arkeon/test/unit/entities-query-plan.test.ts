// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the FTS5 query plan in `listArtifacts`.
 *
 * The text filter used to be wrapped as
 *   EXISTS (SELECT 1 FROM fts_artifacts f WHERE f.path = a.path AND f.text MATCH ?)
 * which SQLite plans as `SCAN artifacts` + per-row FTS lookup — every
 * artifact row scanned, FTS evaluated N times. On a 3k-doc corpus that
 * turned multi-term queries into ~17s. Fixed by driving from
 * `fts_artifacts` and joining back.
 *
 * This test captures every prepared statement during a representative
 * `listArtifacts` call, runs `EXPLAIN QUERY PLAN` on the ones that
 * contain `MATCH`, and asserts the planner is using the FTS virtual
 * table — not scanning artifacts as the outer step, and not pushing
 * the MATCH into a correlated subquery.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/schema/migrate.js";
import { listArtifacts } from "../../src/server/lib/entities.js";
import { closeDb, getDb, initDb } from "../../src/server/lib/sql.js";

let workdir: string;

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-query-plan-"));
  const dbPath = join(workdir, "arke.db");
  initDb(dbPath);
  await runMigrations({ dbPath });
});

afterAll(() => {
  closeDb();
  rmSync(workdir, { recursive: true, force: true });
});

describe("listArtifacts text query plan", () => {
  it("drives text queries from fts_artifacts, not a SCAN of artifacts", async () => {
    const db = getDb();
    const origPrepare = db.prepare.bind(db);
    const prepared: string[] = [];
    // Monkey-patch prepare() so we see the exact SQL the entities
    // layer hands to better-sqlite3 — drift-proof against future edits
    // to the SQL builder.
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      prepared.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    try {
      // Exercise the JOIN path with text + a sibling filter, since the
      // bad pattern was specifically the text branch composed with
      // other WHEREs. The query needn't return rows — we only care
      // about the planner output.
      await listArtifacts({
        text: "anything",
        kinds: ["text"],
        has_tag: ["sentinel"],
      });
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = origPrepare;
    }

    const matchSqls = prepared.filter((s) => /\bMATCH\s+\?/i.test(s));
    expect(matchSqls.length).toBeGreaterThan(0);

    for (const sql of matchSqls) {
      const dummyCount = (sql.match(/\?/g) ?? []).length;
      // EXPLAIN QUERY PLAN doesn't execute the query, but the
      // statement still needs the right placeholder count to prepare.
      const plan = origPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(
        ...Array(dummyCount).fill("x"),
      ) as Array<{ id: number; parent: number; detail: string }>;

      // The bad plan ALWAYS contains a correlated subquery wrapping
      // the FTS MATCH. The good plan never does.
      const joined = plan.map((r) => r.detail).join("\n");
      expect(joined, `plan:\n${joined}\nsql:\n${sql}`).not.toMatch(
        /CORRELATED.*SUBQUERY/i,
      );

      // The outer (parent=0) step that actually drives the join must
      // touch fts_artifacts, not be a SCAN of the artifacts table.
      const topLevel = plan.filter((r) => r.parent === 0);
      const driving = topLevel[0]?.detail ?? "";
      expect(driving, `driving step:\n${driving}\nfull plan:\n${joined}`)
        .toMatch(/VIRTUAL TABLE|fts_artifacts/);
      expect(driving, `driving step:\n${driving}\nfull plan:\n${joined}`)
        .not.toMatch(/SCAN\s+a\b/);
    }
  });
});
