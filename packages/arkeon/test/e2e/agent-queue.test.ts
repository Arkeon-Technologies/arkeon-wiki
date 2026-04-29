// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for the agent_queue helpers. Exercises the SQL roundtrip
 * (enqueue → claim → complete | fail | reclaim) against a real DB,
 * which catches schema or constraint mistakes the unit layer can't.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  claimNext,
  complete,
  enqueue,
  fail,
  queueStats,
  reclaimOrphans,
} from "../../src/server/lib/agent-queue.js";
import { createSql } from "../../src/server/lib/sql.js";

const API_PORT = 18800;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-queue-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });

  process.env.ARKEON_WIKI_HOME = stateDir;

  const dbFile = join(stateDir, "data", "arke.db");
  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: API_PORT, dbPath: dbFile });
  serverHandle = { stop: async () => apiHandle.stop() };

  const spaceRes = await fetch(`http://localhost:${API_PORT}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "queue-space", watch_dir: testDir }),
  });
  const json = (await spaceRes.json()) as { id: string };
  spaceId = json.id;
}, 30_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
}, 30_000);

afterEach(async () => {
  const sql = createSql();
  await sql`DELETE FROM agent_queue`;
});

describe("agent_queue helpers", () => {
  it("enqueue + claim returns the same row", async () => {
    const id = await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/a.md",
      trigger_entity_id: "01ENT_A",
    });
    expect(id).toBeGreaterThan(0);

    const claimed = await claimNext(spaceId, "ingestor");
    expect(claimed).toBeTruthy();
    expect(claimed!.id).toBe(id);
    expect(claimed!.trigger_path).toBe("sources/a.md");
    expect(claimed!.trigger_entity_id).toBe("01ENT_A");
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.started_at).toBeTruthy();
  });

  it("claim returns null when nothing is pending", async () => {
    const claimed = await claimNext(spaceId, "ingestor");
    expect(claimed).toBeNull();
  });

  it("FIFO order across multiple enqueues", async () => {
    await enqueue({ space_id: spaceId, role: "ingestor", trigger_path: "sources/1.md" });
    await new Promise((r) => setTimeout(r, 5)); // distinct enqueued_at
    await enqueue({ space_id: spaceId, role: "ingestor", trigger_path: "sources/2.md" });
    await new Promise((r) => setTimeout(r, 5));
    await enqueue({ space_id: spaceId, role: "ingestor", trigger_path: "sources/3.md" });

    const a = await claimNext(spaceId, "ingestor");
    const b = await claimNext(spaceId, "ingestor");
    const c = await claimNext(spaceId, "ingestor");

    expect(a!.trigger_path).toBe("sources/1.md");
    expect(b!.trigger_path).toBe("sources/2.md");
    expect(c!.trigger_path).toBe("sources/3.md");
  });

  it("does not re-claim a row that's already in flight", async () => {
    await enqueue({ space_id: spaceId, role: "ingestor", trigger_path: "sources/x.md" });
    const first = await claimNext(spaceId, "ingestor");
    expect(first).toBeTruthy();

    const second = await claimNext(spaceId, "ingestor");
    expect(second).toBeNull();
  });

  it("complete() removes the row", async () => {
    const id = await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/done.md",
    });
    await claimNext(spaceId, "ingestor");
    await complete(id);

    const sql = createSql();
    const rows = await sql`SELECT id FROM agent_queue WHERE id = ${id}`;
    expect(rows).toHaveLength(0);
  });

  it("fail() returns the row to pending with last_error set", async () => {
    await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/err.md",
    });
    const claimed = await claimNext(spaceId, "ingestor");
    await fail(claimed!.id, "the LLM exploded");

    const next = await claimNext(spaceId, "ingestor");
    expect(next).toBeTruthy();
    expect(next!.id).toBe(claimed!.id);
    expect(next!.attempts).toBe(2);
    expect(next!.last_error).toBe("the LLM exploded");
  });

  it("UNIQUE coalesces rapid enqueues for the same path", async () => {
    const id1 = await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/edit.md",
      trigger_entity_id: "v1",
    });
    const id2 = await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/edit.md",
      trigger_entity_id: "v2",
    });

    expect(id1).toBe(id2); // same row, just upserted

    const claimed = await claimNext(spaceId, "ingestor");
    expect(claimed!.trigger_entity_id).toBe("v2"); // latest wins

    // Only one row ever existed for this path.
    const stats = await queueStats(spaceId);
    expect(stats.find((s) => s.role === "ingestor")?.in_flight).toBe(1);
  });

  it("upsert resets a previously-failed row to pending", async () => {
    await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/retry.md",
    });
    const first = await claimNext(spaceId, "ingestor");
    await fail(first!.id, "transient");

    // New file save lands while the row is back at pending → upsert.
    await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/retry.md",
      trigger_entity_id: "fresh",
    });

    const next = await claimNext(spaceId, "ingestor");
    expect(next!.attempts).toBe(1); // reset
    expect(next!.last_error).toBeNull();
    expect(next!.trigger_entity_id).toBe("fresh");
  });

  it("reclaimOrphans returns rows whose lease expired", async () => {
    const id = await enqueue({
      space_id: spaceId,
      role: "ingestor",
      trigger_path: "sources/orphan.md",
    });
    await claimNext(spaceId, "ingestor");

    // Backdate started_at past the lease.
    const sql = createSql();
    await sql`
      UPDATE agent_queue
      SET started_at = datetime('now', '-10 minutes')
      WHERE id = ${id}
    `;

    const reclaimed = await reclaimOrphans(5);
    expect(reclaimed).toBe(1);

    const next = await claimNext(spaceId, "ingestor");
    expect(next).toBeTruthy();
    expect(next!.id).toBe(id);
    expect(next!.last_error).toMatch(/lease expired/);
  });

  it("queueStats reports pending and in-flight counts per role", async () => {
    await enqueue({ space_id: spaceId, role: "ingestor", trigger_path: "sources/a.md" });
    await enqueue({ space_id: spaceId, role: "ingestor", trigger_path: "sources/b.md" });
    await claimNext(spaceId, "ingestor");

    const stats = await queueStats(spaceId);
    const ing = stats.find((s) => s.role === "ingestor");
    expect(ing).toBeTruthy();
    expect(ing!.pending).toBe(1);
    expect(ing!.in_flight).toBe(1);
  });
});
