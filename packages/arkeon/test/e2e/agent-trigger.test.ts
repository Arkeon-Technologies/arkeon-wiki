// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for the scheduler — the bridge between the file watcher
 * and the agent runtime.
 *
 * We drive the scheduler directly (`scheduler.notify(...)`) with an
 * injected fake `runAgent` instead of going through the actual
 * fs.watch chain. The watcher → scheduler.notify call is a single
 * line of integration in fs-watcher.ts, exercised by the manual
 * real-LLM test; this file owns the scheduler's queue + worker
 * semantics.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { startScheduler } from "../../src/server/agents/scheduler.js";
import { applyEdit } from "../../src/server/lib/file-edits.js";
import { createSql } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";
import type { AgentRunResult } from "../../src/server/agents/runtime.js";

let testDir: string;
let stateDir: string;
let space: Space;

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-trigger-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });
  mkdirSync(join(testDir, ".arkeon"), { recursive: true });

  // Plant an agents.yaml so role-builder can resolve the ingestor.
  // The fake runAgent never hits the network so the model spec is
  // irrelevant — but the schema must validate.
  writeFileSync(
    join(testDir, ".arkeon", "agents.yaml"),
    "defaults:\n  provider: openai\n  model: gpt-mock\n",
  );

  process.env.ARKEON_WIKI_HOME = stateDir;
  process.env.OPENAI_API_KEY = "sk-mock";

  const dbFile = join(stateDir, "data", "arke.db");
  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  // Insert the space directly via SQL (no API server, no fs.watch).
  const sql = createSql();
  const id = `01TEST${randomBytes(8).toString("hex").toUpperCase()}`;
  await sql`
    INSERT INTO spaces (id, name, watch_dir)
    VALUES (${id}, ${"trigger-space"}, ${testDir})
  `;
  space = { id, name: "trigger-space", watch_dir: testDir };
}, 30_000);

afterAll(async () => {
  delete process.env.OPENAI_API_KEY;
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  const sql = createSql();
  await sql`DELETE FROM agent_queue`;
  await sql`DELETE FROM agent_runs`;
});

async function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function makeFakeRunAgent(behavior: {
  writes?: Array<{ path: string; content: string }>;
  fail?: boolean;
}) {
  return vi.fn(async (role, input, _registry, _opts): Promise<AgentRunResult> => {
    if (behavior.fail) {
      throw new Error("simulated provider failure");
    }
    const edits = [];
    for (const w of behavior.writes ?? []) {
      const result = await applyEdit(input.space, {
        kind: "write",
        path: w.path,
        content: w.content,
      });
      edits.push(result);
    }
    return {
      skipped: false,
      edits,
      text: "fake done",
      steps: 1,
    };
  });
}

describe("scheduler — auto-trigger from file events", () => {
  it("notify() enqueues a non-wiki path, worker drains, runAgent called", async () => {
    const fake = makeFakeRunAgent({
      writes: [
        {
          path: "wiki/concept/auto-fired.md",
          content:
            "---\nlabel: Auto Fired\nsubject_type: concept\n---\n\nfrom fake\n",
        },
      ],
    });

    const scheduler = await startScheduler({
      space,
      runAgentFn: fake,
    });

    try {
      await scheduler.notify("sources/trigger-me.md", "01ENT_SOURCE");

      // Wait for the worker to drain.
      await waitFor(() => {
        return existsSync(join(testDir, "wiki/concept/auto-fired.md"));
      });

      expect(fake).toHaveBeenCalledTimes(1);
      // Verify the runAgent was called with the right input.
      const call = fake.mock.calls[0];
      expect(call[0].name).toBe("ingestor");
      expect(call[1].triggerPath).toBe("sources/trigger-me.md");
      expect(call[1].triggerEntityId).toBe("01ENT_SOURCE");

      // Successful run → queue row deleted.
      const sql = createSql();
      const queueRows = await sql`
        SELECT id FROM agent_queue
        WHERE space_id = ${space.id} AND trigger_path = ${"sources/trigger-me.md"}
      `;
      expect(queueRows).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("does NOT enqueue wiki/** paths (loop prevention)", async () => {
    const fake = makeFakeRunAgent({});

    const scheduler = await startScheduler({
      space,
      runAgentFn: fake,
    });

    try {
      await scheduler.notify("wiki/person/foo.md", "01ENT_WIKI");
      await scheduler.notify("wiki/concept/bar.md");

      // Give the worker time to claim — it should find nothing.
      await new Promise((r) => setTimeout(r, 300));

      expect(fake).not.toHaveBeenCalled();

      const sql = createSql();
      const queueRows = await sql`
        SELECT id FROM agent_queue WHERE space_id = ${space.id}
      `;
      expect(queueRows).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("does NOT enqueue .arkeon/** paths", async () => {
    const fake = makeFakeRunAgent({});
    const scheduler = await startScheduler({ space, runAgentFn: fake });
    try {
      await scheduler.notify(".arkeon/state.json");
      await new Promise((r) => setTimeout(r, 200));
      expect(fake).not.toHaveBeenCalled();
    } finally {
      await scheduler.stop();
    }
  });

  it("records last_error and resets to pending when the run fails", async () => {
    const fake = makeFakeRunAgent({ fail: true });

    const scheduler = await startScheduler({
      space,
      runAgentFn: fake,
    });

    try {
      await scheduler.notify("sources/will-fail.md");

      const row = await waitFor(async () => {
        const sql = createSql();
        const rows = await sql`
          SELECT id, started_at, attempts, last_error
          FROM agent_queue
          WHERE space_id = ${space.id} AND trigger_path = ${"sources/will-fail.md"}
        `;
        const r = rows[0];
        if (r && r.last_error) return r;
        return null;
      });

      expect(row.started_at).toBeNull();
      expect(row.attempts as number).toBeGreaterThanOrEqual(1);
      expect(String(row.last_error)).toMatch(/simulated provider failure/);
    } finally {
      await scheduler.stop();
    }
  });

  it("coalesces rapid notify() calls for the same path", async () => {
    const fake = makeFakeRunAgent({
      writes: [
        {
          path: "wiki/concept/coalesced.md",
          content: "---\nlabel: Coalesced\n---\n\nbody\n",
        },
      ],
    });

    const scheduler = await startScheduler({
      space,
      runAgentFn: fake,
    });

    try {
      // Five rapid saves of the same source — should coalesce to one
      // queue row + one run.
      for (let i = 0; i < 5; i++) {
        await scheduler.notify("sources/rapid.md", `v${i}`);
      }

      await waitFor(() =>
        existsSync(join(testDir, "wiki/concept/coalesced.md")),
      );

      // Give time for any extra runs that shouldn't happen.
      await new Promise((r) => setTimeout(r, 300));

      // Either the worker processed them as 1 (UPSERT means same row)
      // or it ran multiple times if claims raced before later notifies.
      // Real assertion: we didn't run 5 times, and the queue is empty.
      expect(fake).toHaveBeenCalled();
      expect(fake.mock.calls.length).toBeLessThan(5);

      const sql = createSql();
      const queueRows = await sql`
        SELECT id FROM agent_queue
        WHERE space_id = ${space.id} AND trigger_path = ${"sources/rapid.md"}
      `;
      expect(queueRows).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("reclaims orphaned in-flight rows on scheduler startup", async () => {
    // Plant a row that's been "in flight" for too long (simulating a
    // crashed daemon).
    const sql = createSql();
    await sql`
      INSERT INTO agent_queue
        (space_id, role, trigger_path, started_at, attempts)
      VALUES
        (${space.id}, ${"ingestor"}, ${"sources/orphan.md"},
         datetime('now', '-10 minutes'), 1)
    `;

    const fake = makeFakeRunAgent({
      writes: [
        {
          path: "wiki/concept/recovered.md",
          content: "---\nlabel: Recovered\n---\n\nbody\n",
        },
      ],
    });

    // Starting a scheduler should reclaim the orphan and process it.
    const scheduler = await startScheduler({
      space,
      runAgentFn: fake,
    });

    try {
      await waitFor(() =>
        existsSync(join(testDir, "wiki/concept/recovered.md")),
      );
      expect(fake).toHaveBeenCalledTimes(1);
    } finally {
      await scheduler.stop();
    }
  });
});
