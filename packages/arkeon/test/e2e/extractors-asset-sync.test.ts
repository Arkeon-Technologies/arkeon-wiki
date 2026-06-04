// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused stress test for the chunked asset-sync path in
 * `runner.ts:syncAssetsParallel`.
 *
 * The path is the bottleneck a 500+ page PDF hits post-extraction —
 * each asset goes through `syncFile` (FS read + SHA-256 + SQL
 * insert). Without this test the contract relies on incidental
 * coverage from the PDF e2e (which can't run in CI without PyMuPDF).
 *
 * What this locks in:
 *   1. All N assets end up indexed (no batches dropped).
 *   2. Per-asset failures are isolated — one pathological file
 *      doesn't abort the batch.
 *   3. Progress logging fires at every ASSET_PROGRESS_INTERVAL
 *      boundary AND only when `done < total` (so the final batch
 *      doesn't double-log alongside the runner's "extraction
 *      complete" line).
 *   4. The runtime is materially faster than serial — a sanity
 *      check, not a perf benchmark.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  _assetProgressIntervalForTest,
  _assetSyncConcurrencyForTest,
  _syncAssetsParallelForTest,
} from "../../src/server/extractors/runner.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";

let workdir: string;
let assetsAbsDir: string;
const assetsRelDir = ".sidecars/stress-fixture.pdf.assets";

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-asset-sync-"));
  const dbPath = join(workdir, "arke.db");
  initDb(dbPath);
  await runMigrations({ dbPath });
  assetsAbsDir = join(workdir, assetsRelDir);
  mkdirSync(assetsAbsDir, { recursive: true });
});

afterAll(() => {
  closeDb();
  rmSync(workdir, { recursive: true, force: true });
});

describe("syncAssetsParallel — stress + contract", () => {
  it("indexes 250 synthetic assets and logs progress at the 100/200 boundaries", async () => {
    // Confirm we're calibrating against the values the runner ships
    // with, so the assertions remain meaningful if the defaults move.
    expect(_assetSyncConcurrencyForTest).toBeGreaterThanOrEqual(1);
    expect(_assetProgressIntervalForTest).toBe(100);

    const N = 250;
    const names: string[] = [];
    for (let i = 1; i <= N; i++) {
      const name = `page-${String(i).padStart(4, "0")}.png`;
      // Distinct content per file so each row gets a real hash —
      // otherwise SQLite dedup could mask a missed insert.
      writeFileSync(join(assetsAbsDir, name), `synthetic-asset-${i}`);
      names.push(name);
    }

    const logs: Array<{ level: string; msg: string }> = [];
    const log = (level: "info" | "warn" | "error", msg: string): void => {
      logs.push({ level, msg });
    };

    const start = Date.now();
    await _syncAssetsParallelForTest({
      assetNames: names,
      watchedRoot: workdir,
      assetsSpaceRelDir: assetsRelDir,
      log,
    });
    const elapsedMs = Date.now() - start;

    // Every asset must land as an artifact row.
    const sql = createSql();
    const rows = (await sql.query(
      `SELECT path FROM artifacts WHERE path LIKE ? ORDER BY path`,
      [`${assetsRelDir}/%`],
    )) as Array<{ path: string }>;
    expect(rows.length).toBe(N);
    expect(rows[0]!.path).toBe(`${assetsRelDir}/page-0001.png`);
    expect(rows[N - 1]!.path).toBe(`${assetsRelDir}/page-0250.png`);

    // Progress logs at exactly 100/250 and 200/250. The 250/250
    // final-batch log is suppressed by the `done < total` guard —
    // the runner's "extraction complete" line covers it.
    const progressLines = logs.filter((l) => l.msg.startsWith("syncing assets:"));
    expect(progressLines.map((l) => l.msg)).toEqual([
      "syncing assets: 100 / 250",
      "syncing assets: 200 / 250",
    ]);

    // No warnings on the happy path.
    expect(logs.filter((l) => l.level === "warn")).toEqual([]);

    // Sanity: 250 sequential syncFile calls take well over 1s in
    // local testing; concurrency 16 should finish far under that.
    // Loose bound to stay green on slow CI runners.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("doesn't emit progress logs for small batches (total ≤ interval)", async () => {
    const subdir = ".sidecars/small-fixture.pdf.assets";
    mkdirSync(join(workdir, subdir), { recursive: true });
    const names: string[] = [];
    for (let i = 1; i <= 50; i++) {
      const name = `tiny-${i}.bin`;
      writeFileSync(join(workdir, subdir, name), `small-${i}`);
      names.push(name);
    }
    const logs: string[] = [];
    await _syncAssetsParallelForTest({
      assetNames: names,
      watchedRoot: workdir,
      assetsSpaceRelDir: subdir,
      log: (_level, msg) => logs.push(msg),
    });
    expect(logs.filter((m) => m.startsWith("syncing assets:"))).toEqual([]);
  });

  it("isolates per-asset failures — one missing file doesn't abort the batch", async () => {
    const subdir = ".sidecars/partial-fixture.pdf.assets";
    mkdirSync(join(workdir, subdir), { recursive: true });
    const names: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const name = `real-${i}.bin`;
      writeFileSync(join(workdir, subdir, name), `partial-${i}`);
      names.push(name);
    }
    // Inject a name that doesn't correspond to a real file on disk;
    // syncFile will throw and the helper should log + continue.
    names.splice(2, 0, "missing-on-disk.bin");

    const logs: Array<{ level: string; msg: string }> = [];
    await _syncAssetsParallelForTest({
      assetNames: names,
      watchedRoot: workdir,
      assetsSpaceRelDir: subdir,
      log: (level, msg) => logs.push({ level, msg }),
    });

    const sql = createSql();
    const rows = (await sql.query(
      `SELECT path FROM artifacts WHERE path LIKE ?`,
      [`${subdir}/%`],
    )) as Array<{ path: string }>;
    // All 5 real files landed; the missing one did not.
    expect(rows.length).toBe(5);
    const warnLines = logs.filter((l) => l.level === "warn");
    expect(warnLines.length).toBe(1);
    expect(warnLines[0]!.msg).toContain("missing-on-disk.bin");
  });
});
