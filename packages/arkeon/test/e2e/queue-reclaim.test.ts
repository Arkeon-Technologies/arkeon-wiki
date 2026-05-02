// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Daemon restart resilience for the embedding queue (issue #47).
 *
 * Exercises the lease-expiration reclaim path that the embedding
 * worker runs on startup. Without this test the path is dead code
 * until a real user's daemon crashes — which means we'd discover any
 * regression after someone loses an embedding job.
 *
 * Scenario:
 *   1. Daemon A starts, writes wikis, embedding queue accumulates.
 *   2. Daemon A claims an item but is killed before completing it
 *      (we simulate by directly inserting into embedding_queue with
 *      a started_at older than the lease TTL).
 *   3. Daemon B starts. Its first action is reclaimOrphans(); the
 *      stale rows reset to pending.
 *   4. The worker drains them; the chunks end up embedded.
 *
 * Runs in CI with the mock embedder.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { createSql } from "../../src/server/lib/sql.js";
import {
  reclaimOrphans,
  queueStats,
  waitForDrain,
  ORPHAN_LEASE_MINUTES,
} from "../../src/server/lib/embedding-queue.js";
import { resetEmbedder } from "../../src/server/lib/embedder/index.js";
import { waitForEntityBySourcePath } from "./helpers.js";

const API_PORT = 18795;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let dbFile: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;

function writeWiki(
  relativePath: string,
  properties: Record<string, unknown>,
  body: string,
): void {
  const absPath = join(testDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const fm = yaml.dump(properties, { schema: yaml.JSON_SCHEMA, sortKeys: false }).trimEnd();
  writeFileSync(absPath, `---\n${fm}\n---\n\n${body}\n`);
}

async function startServer(): Promise<{ stop: () => Promise<void> }> {
  resetEmbedder();
  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: API_PORT, dbPath: dbFile });
  return { stop: async () => apiHandle.stop() };
}

beforeAll(async () => {
  // setup.ts forces ARKEON_WIKI_EMBEDDER=mock for e2e — no model
  // download triggered.

  const base = join(tmpdir(), `arkeon-reclaim-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });

  process.env.ARKEON_WIKI_HOME = stateDir;
  dbFile = join(stateDir, "data", "arke.db");

  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  serverHandle = await startServer();

  const created = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "reclaim-space", watch_dir: testDir }),
  });
  spaceId = ((await created.json()) as { id: string }).id;
}, 60_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
}, 30_000);

describe("embedding queue — orphan reclaim on daemon restart", () => {
  it("reclaims rows whose started_at is older than the lease TTL", async () => {
    // Land a wiki and let the worker process it, so we have a real
    // entity_id we can attach a fake stale queue row to.
    writeWiki(
      "wiki/person/probe-stale.md",
      { label: "Probe Stale", subject_type: "person" },
      "Subject under test for the lease-expiration reclaim path.",
    );
    const entity = await waitForEntityBySourcePath(spaceId, "wiki/person/probe-stale.md");
    await waitForDrain(15_000);

    // Forcibly insert (or upsert) a queue row with a started_at that's
    // older than the lease TTL — simulating a daemon that claimed the
    // row and then died. We use SQLite's datetime() with a negative
    // offset rather than a client-side ISO timestamp because the two
    // formats compare differently (`2026-05-02 15:00:00` vs
    // `2026-05-02T15:00:00.000Z`) and the reclaim WHERE clause uses
    // SQLite's space-separated format.
    const sql = createSql();
    const staleOffset = `-${ORPHAN_LEASE_MINUTES + 5} minutes`;
    await sql`
      INSERT INTO embedding_queue (entity_id, started_at, attempts)
      VALUES (${entity.id}, datetime('now', ${staleOffset}), 1)
      ON CONFLICT(entity_id) DO UPDATE SET
        started_at = datetime('now', ${staleOffset}),
        attempts = 1,
        last_error = NULL
    `;

    const beforeStats = await queueStats();
    expect(beforeStats.in_flight).toBe(1);

    // The reclaim helper is what the worker calls on its startup. We
    // can either restart the server (slow, exercises the wiring) or
    // call the function directly (fast, exercises the SQL). Both have
    // value — call directly first for a tight test, restart below
    // for the integration view.
    const reclaimed = await reclaimOrphans();
    expect(reclaimed).toBe(1);

    const afterStats = await queueStats();
    expect(afterStats.in_flight).toBe(0);
    expect(afterStats.pending).toBe(1);

    // The worker is still running and will pick the row up on its next
    // poll cycle (default 500ms). Wait for the queue to drain.
    await waitForDrain(15_000);
    expect((await queueStats()).pending).toBe(0);
  });

  it("does NOT reclaim rows whose started_at is fresh (still within lease)", async () => {
    writeWiki(
      "wiki/person/probe-fresh.md",
      { label: "Probe Fresh", subject_type: "person" },
      "Subject for the negative-side reclaim test.",
    );
    const entity = await waitForEntityBySourcePath(spaceId, "wiki/person/probe-fresh.md");
    await waitForDrain(15_000);

    // Insert with a started_at that's well within the lease window.
    const sql = createSql();
    await sql`
      INSERT INTO embedding_queue (entity_id, started_at, attempts)
      VALUES (${entity.id}, datetime('now', '-30 seconds'), 1)
      ON CONFLICT(entity_id) DO UPDATE SET
        started_at = datetime('now', '-30 seconds'),
        attempts = 1
    `;

    const reclaimed = await reclaimOrphans();
    expect(reclaimed).toBe(0);

    // Clean up — the worker will keep waiting for the lease to
    // expire, which won't happen in this test. Manually drop the
    // queue row.
    await sql`DELETE FROM embedding_queue WHERE entity_id = ${entity.id}`;
  });

  it("end-to-end: full daemon restart reclaims orphaned rows automatically", async () => {
    writeWiki(
      "wiki/person/probe-restart.md",
      { label: "Probe Restart", subject_type: "person" },
      "Subject for the full daemon-restart reclaim test.",
    );
    const entity = await waitForEntityBySourcePath(spaceId, "wiki/person/probe-restart.md");
    await waitForDrain(15_000);

    // Plant a stale row. The currently-running worker won't see it
    // because we set started_at NOT NULL — claimNext only picks up
    // rows with started_at IS NULL. But the running worker's
    // reclaimOrphans was already called once at startup; we want to
    // exercise the case where a NEW daemon starts and the reclaim
    // fires on its startup.
    const sql = createSql();
    const staleOffset = `-${ORPHAN_LEASE_MINUTES + 5} minutes`;
    await sql`
      INSERT INTO embedding_queue (entity_id, started_at, attempts)
      VALUES (${entity.id}, datetime('now', ${staleOffset}), 1)
      ON CONFLICT(entity_id) DO UPDATE SET
        started_at = datetime('now', ${staleOffset}),
        attempts = 1,
        last_error = NULL
    `;

    // Stop the running daemon and start a fresh one — the new
    // daemon's startEmbeddingWorker calls reclaimOrphans() before
    // beginning to drain.
    if (serverHandle) await serverHandle.stop();
    serverHandle = await startServer();

    // The new worker reclaims, then drains. Give it time.
    await waitForDrain(15_000);
    expect((await queueStats()).pending).toBe(0);
    expect((await queueStats()).in_flight).toBe(0);
  });
});
