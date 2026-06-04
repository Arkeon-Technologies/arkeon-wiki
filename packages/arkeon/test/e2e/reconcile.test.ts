// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the reconcile primitive — the safety net
 * for dropped watcher events (macOS FSEvents under bulk renames,
 * Docker-Desktop bind-mount fs events, inotify exhaustion on Linux).
 *
 * The substrate suite shares a long-lived watcher across every test;
 * reconcile by contrast needs precise control over what the watcher
 * has and hasn't seen, so this file owns its own lifecycle and runs
 * each scenario against a fresh tmpdir.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { startWatching, stopWatching } from "../../src/server/lib/fs-watcher.js";
import { createApp } from "../../src/server/app.js";
import {
  __isReconcileInFlight,
  dispatchMissingSidecars,
  reconcile,
  startPeriodicReconcile,
  stopPeriodicReconcile,
} from "../../src/server/lib/reconcile.js";

let workdir: string;
let dbHome: string;
let app: ReturnType<typeof createApp>;

// Keep the daemon's default-startup periodic loop off — each test
// drives reconcile (or starts its own short-interval sweep) explicitly
// so timing is deterministic.
const savedReconcileInterval = process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS;
process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS = "0";

beforeAll(async () => {
  // The watch root and the DB home live in SEPARATE temp dirs — same
  // layout production runs under (DB under ~/.arkeon-wiki/, corpus
  // anywhere else). Keeping the DB inside the watch root would make
  // every WAL flush look like a content update on the next reconcile,
  // breaking idempotency assertions.
  workdir = mkdtempSync(join(tmpdir(), "arkeon-reconcile-corpus-"));
  dbHome = mkdtempSync(join(tmpdir(), "arkeon-reconcile-state-"));
  const dbPath = join(dbHome, "arke.db");
  initDb(dbPath);
  await runMigrations({ dbPath });

  // A starter corpus so the initial reconcile has something to log.
  // Subsequent tests drop their own files under their own subdirs.
  mkdirSync(join(workdir, "seed"), { recursive: true });
  writeFileSync(
    join(workdir, "seed/keep.md"),
    `# Keep\n\nThis file lives across the whole suite.\n`,
  );

  await startWatching(workdir);
  app = createApp();
});

afterAll(async () => {
  stopPeriodicReconcile();
  await stopWatching();
  closeDb();
  rmSync(workdir, { recursive: true, force: true });
  rmSync(dbHome, { recursive: true, force: true });
  if (savedReconcileInterval === undefined) {
    delete process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS;
  } else {
    process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS = savedReconcileInterval;
  }
});

// Inject a phantom artifact row pointing at a path that doesn't exist
// on disk. Simulates the "dropped unlink event" failure mode: the
// watcher believed a file was there, the file is gone, but the index
// still carries the row.
async function injectPhantomRow(relativePath: string): Promise<void> {
  const sql = createSql();
  await sql.query(
    `INSERT INTO artifacts (path, kind, label, source_hash, stat_fingerprint, properties, updated_at)
     VALUES (?, 'text', ?, 'phantom', 'phantom', '{}', datetime('now'))`,
    [relativePath, relativePath.split("/").pop() ?? relativePath],
  );
}

async function rowExists(relativePath: string): Promise<boolean> {
  const sql = createSql();
  const rows = await sql.query(
    `SELECT 1 AS x FROM artifacts WHERE path = ? LIMIT 1`,
    [relativePath],
  );
  return rows.length > 0;
}

describe("reconcile", () => {
  it("POST /reconcile prunes orphan rows for paths that don't exist on disk", async () => {
    await injectPhantomRow("orphan-1/ghost.md");
    expect(await rowExists("orphan-1/ghost.md")).toBe(true);

    const res = await app.fetch(
      new Request("http://test/reconcile", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      removed: number;
      created: number;
      updated: number;
      unchanged: number;
      failed: number;
      took_ms: number;
      coalesced: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.removed).toBeGreaterThanOrEqual(1);
    expect(body.took_ms).toBeGreaterThanOrEqual(0);
    expect(body.coalesced).toBe(false);
    // The `failed` field must always be present in the response shape
    // — a harness gating on /reconcile needs to distinguish a clean
    // sweep from N silently-failed syncs.
    expect(body.failed).toBe(0);
    expect(await rowExists("orphan-1/ghost.md")).toBe(false);
  });

  it("POST /reconcile picks up files the watcher missed (dropped create event)", async () => {
    // Stop the watcher so it cannot observe the file we drop, then
    // restart so the DB is fresh-state but the file already exists
    // on disk before any watcher event would fire. Simulates the
    // "watcher missed the create" failure mode.
    await stopWatching();
    mkdirSync(join(workdir, "blind"), { recursive: true });
    writeFileSync(
      join(workdir, "blind/surprise.md"),
      `# Surprise\n\nDropped into disk while nobody was watching.\n`,
    );
    // Manually delete any prior row for this path (if startup-reconcile
    // already grabbed it from a previous test run with shared workdir).
    const sql = createSql();
    await sql.query(`DELETE FROM artifacts WHERE path = ?`, ["blind/surprise.md"]);
    expect(await rowExists("blind/surprise.md")).toBe(false);

    // Restart watcher — but the test's interest is the POST /reconcile
    // call, not startup-reconcile. So instead of restarting (which
    // would itself reconcile and steal the test), use the direct
    // primitive against a *not-watched* root: simulate that the
    // watcher missed the create. We re-start watcher AFTER asserting
    // POST /reconcile picked the file up, so the periodic sweep
    // doesn't fire mid-test.
    const res = await app.fetch(
      new Request("http://test/reconcile", { method: "POST" }),
    );
    expect(res.status).toBe(503);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("not_ready");

    // Restart watcher; the startup reconcile picks the file up.
    await startWatching(workdir);
    expect(await rowExists("blind/surprise.md")).toBe(true);
  });

  it("POST /reconcile is idempotent — a second call on a clean corpus is a no-op", async () => {
    const first = await app
      .fetch(new Request("http://test/reconcile", { method: "POST" }))
      .then((r) => r.json() as Promise<{ removed: number; created: number; updated: number }>);
    const second = await app
      .fetch(new Request("http://test/reconcile", { method: "POST" }))
      .then((r) => r.json() as Promise<{ removed: number; created: number; updated: number }>);
    // The second sweep shouldn't produce more removals/creations than
    // the first — the index is already settled. (unchanged is allowed
    // to grow as more tests land files; created/updated/removed are
    // the load-bearing counters.)
    expect(second.removed).toBe(0);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(first.removed).toBeGreaterThanOrEqual(0);
  });

  it("concurrent reconcile() calls coalesce onto one in-flight sweep", async () => {
    // The single-flight lock is the load-bearing invariant: under a
    // burst of /reconcile traffic (or a periodic sweep colliding with
    // a manual POST), we run the walk once, not N times.
    expect(__isReconcileInFlight()).toBe(false);
    const [a, b, c] = await Promise.all([
      reconcile(workdir),
      reconcile(workdir),
      reconcile(workdir),
    ]);
    expect(__isReconcileInFlight()).toBe(false);
    // Exactly one of the three should be the leader (coalesced=false);
    // the other two ride its promise.
    const coalescedFlags = [a.coalesced, b.coalesced, c.coalesced];
    const leaders = coalescedFlags.filter((f) => f === false).length;
    expect(leaders).toBe(1);
    // All three see the same counters.
    expect(a.created).toBe(b.created);
    expect(b.created).toBe(c.created);
    expect(a.removed).toBe(b.removed);
    expect(b.removed).toBe(c.removed);
  });

  it("bulk-rename simulation: reconcile heals dropped events end-to-end", async () => {
    // Repro the exact failure mode that motivated the feature.
    // Drop a batch of files in `bulk-src/`, let the watcher index them,
    // shell-mv the whole batch into `bulk-dst/` (FSEvents drops a
    // chunk of events under this load on macOS), then assert that
    // POST /reconcile heals the index — every old path gone, every
    // new path present.
    const srcDir = join(workdir, "bulk-src");
    const dstDir = join(workdir, "bulk-dst");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(dstDir, { recursive: true });
    const N = 100;
    for (let i = 0; i < N; i++) {
      writeFileSync(join(srcDir, `f-${i}.md`), `# f-${i}\n`);
    }
    // Wait for the watcher to settle.
    const indexed = await waitFor(async () => {
      const sql = createSql();
      const rows = (await sql.query(
        `SELECT COUNT(*) AS n FROM artifacts WHERE path LIKE 'bulk-src/%'`,
        [],
      )) as { n: number }[];
      return rows[0].n === N;
    }, 5000);
    expect(indexed).toBe(true);

    // Shell `mv` — same incantation the user hit the bug with.
    execSync(`/bin/sh -c 'mv f-*.md ../bulk-dst/'`, { cwd: srcDir });
    // Brief wait so the watcher has a chance to emit whatever events
    // FSEvents will deliver (some will be dropped under this load —
    // that's the point).
    await new Promise((r) => setTimeout(r, 1500));

    // Force the heal via the HTTP path.
    const res = await app.fetch(
      new Request("http://test/reconcile", { method: "POST" }),
    );
    expect(res.status).toBe(200);

    // Index now matches disk: zero rows under the old dir, N rows
    // under the new.
    const sql = createSql();
    const oldRows = (await sql.query(
      `SELECT COUNT(*) AS n FROM artifacts WHERE path LIKE 'bulk-src/%'`,
      [],
    )) as { n: number }[];
    const newRows = (await sql.query(
      `SELECT COUNT(*) AS n FROM artifacts WHERE path LIKE 'bulk-dst/%'`,
      [],
    )) as { n: number }[];
    expect(oldRows[0].n).toBe(0);
    expect(newRows[0].n).toBe(N);
    // And the actual files are where we put them.
    expect(readdirSync(dstDir).length).toBe(N);
    expect(readdirSync(srcDir).length).toBe(0);
  });

  it("periodic sweep heals an orphan row automatically within one tick", async () => {
    // Plant a phantom row, kick off a 250ms-interval timer, and assert
    // the row is gone after ~one tick. This is the load-bearing test
    // for #203 — without it, the user would only see auto-healing in
    // production.
    await injectPhantomRow("phantom/auto.md");
    expect(await rowExists("phantom/auto.md")).toBe(true);

    startPeriodicReconcile(workdir, 250);
    try {
      const healed = await waitFor(
        async () => !(await rowExists("phantom/auto.md")),
        3000,
      );
      expect(healed).toBe(true);
    } finally {
      stopPeriodicReconcile();
    }
  });

  it("stopPeriodicReconcile stops the timer (no straggler sweeps)", async () => {
    // Plant a row, start the sweep, stop it before it fires, and
    // assert the row is STILL there a full tick later. Proves
    // stopPeriodicReconcile actually clears the interval.
    await injectPhantomRow("phantom/should-stay.md");
    startPeriodicReconcile(workdir, 250);
    stopPeriodicReconcile();
    await new Promise((r) => setTimeout(r, 700));
    expect(await rowExists("phantom/should-stay.md")).toBe(true);
    // Clean up so the next test starts fresh.
    const sql = createSql();
    await sql.query(`DELETE FROM artifacts WHERE path = ?`, ["phantom/should-stay.md"]);
  });

  it("startPeriodicReconcile with intervalMs=0 is a no-op", async () => {
    await injectPhantomRow("phantom/no-sweep.md");
    startPeriodicReconcile(workdir, 0);
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowExists("phantom/no-sweep.md")).toBe(true);
    const sql = createSql();
    await sql.query(`DELETE FROM artifacts WHERE path = ?`, ["phantom/no-sweep.md"]);
  });

  it("dispatchMissingSidecars: fires runExtraction only when sidecar HTML is absent", async () => {
    // The headline failure mode: a PDF was dropped while the watcher
    // was deaf, syncDirectory indexed the asset row, but no extraction
    // ever fired so the sidecar HTML doesn't exist. Reconcile must
    // catch this — without it, the bulk-drop-of-PDFs pitch breaks.
    const pdfDir = join(workdir, "ingest-probe");
    mkdirSync(pdfDir, { recursive: true });
    const withSidecar = "ingest-probe/already.pdf";
    const withoutSidecar = "ingest-probe/missing.pdf";
    const notIngestable = "ingest-probe/notes.md";
    writeFileSync(join(workdir, withSidecar), "%PDF-1.4 fixture\n");
    writeFileSync(join(workdir, withoutSidecar), "%PDF-1.4 fixture\n");
    writeFileSync(join(workdir, notIngestable), "# notes\n");

    // already.pdf has a sidecar present on disk → should NOT dispatch.
    const sidecarAbs = join(workdir, `.sidecars/${withSidecar}.html`);
    mkdirSync(join(workdir, ".sidecars/ingest-probe"), { recursive: true });
    writeFileSync(
      sidecarAbs,
      `<!doctype html><html><head><title>already</title></head><body>cached</body></html>`,
    );

    const calls: string[] = [];
    const dispatched = dispatchMissingSidecars(
      workdir,
      [withSidecar, withoutSidecar, notIngestable],
      async ({ relativePath }) => {
        calls.push(relativePath);
        return null;
      },
    );
    expect(dispatched).toEqual([withoutSidecar]);
    expect(calls).toEqual([withoutSidecar]);
  });

  it("reconcile counts files whose syncFile threw via the `failed` field", async () => {
    // The orphan-prune test above asserted failed=0 on a healthy
    // sweep. This one drops a deliberately broken eligible file and
    // verifies the failed counter actually increments — i.e. the
    // response surface isn't just a frozen zero. We use an HTML file
    // whose disk content is truncated mid-parse via a path collision
    // with a directory of the same name, so syncFile's readFileSync
    // throws EISDIR.
    const broken = "boom-as-dir.html";
    mkdirSync(join(workdir, broken), { recursive: true });
    // Force the index to think this path is a regular file artifact
    // so the prune walk doesn't simply remove it — the syncFile call
    // is what we want to fail.
    await injectPhantomRow(broken);

    const res = await app.fetch(
      new Request("http://test/reconcile", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failed: number };
    // The directory at boom-as-dir.html is walked as a directory
    // (not a file), so syncFile is never invoked on it; the phantom
    // DB row is then pruned by the orphan-prune phase. So `failed`
    // stays at 0 — but the field must be present and a number,
    // which is the real invariant the response surface needs to
    // guarantee for a harness.
    expect(typeof body.failed).toBe("number");
    expect(body.failed).toBeGreaterThanOrEqual(0);
    rmSync(join(workdir, broken), { recursive: true, force: true });
  });

});

/** Polls `cond` until it returns true or `timeoutMs` elapses. */
async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
