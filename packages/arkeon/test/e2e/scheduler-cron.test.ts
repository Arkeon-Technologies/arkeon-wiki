// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the cron scheduler. Uses an injected
 * runAgentFn (no LLM/network calls) and `vi.useFakeTimers()` to drive
 * tick firings without waiting for wall-clock seconds. Asserts:
 *
 *   1. A tick fires runAgent and the next tick is scheduled after the
 *      run completes (no deadlock).
 *   2. Per-space mutex: when role A is running and role B's tick
 *      fires, role B is skipped (skip-if-busy) — not queued, not
 *      run in parallel.
 *   3. stop() returns within ~gracePeriodMs even when an in-flight
 *      run hangs, instead of waiting for the run forever.
 *   4. Roles without a resolvable cron expression aren't scheduled.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { runMigrations } from "../../src/schema/index.js";
import { closeDb, createSql } from "../../src/server/lib/sql.js";
import { generateUlid } from "../../src/server/lib/ids.js";
import { startScheduler } from "../../src/server/agents/scheduler.js";
import type {
  AgentInput,
  AgentRole,
  AgentRunResult,
  ToolRegistry,
} from "../../src/server/agents/runtime.js";
import type { Space } from "../../src/server/lib/sync.js";

let testDir: string;
let stateDir: string;

beforeAll(async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  const base = join(tmpdir(), `arkeon-cron-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });

  process.env.DATABASE_PATH = join(stateDir, "data", "arke.db");
  await runMigrations({ dbPath: process.env.DATABASE_PATH });
}, 30_000);

afterAll(async () => {
  closeDb();
  if (testDir) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
  delete process.env.OPENAI_API_KEY;
}, 10_000);

afterEach(() => {
  // Each test that flips fake timers on must restore real timers
  // before exiting; defensive belt-and-braces here so a thrown
  // assertion can't poison sibling tests.
  vi.useRealTimers();
});

async function makeSpaceWithConfig(yamlBody: string): Promise<Space> {
  const spaceDir = join(testDir, randomBytes(4).toString("hex"));
  mkdirSync(join(spaceDir, ".arkeon"), { recursive: true });
  writeFileSync(join(spaceDir, ".arkeon", "agents.yaml"), yamlBody);
  const space: Space = {
    id: generateUlid(),
    name: `cron-test-${randomBytes(2).toString("hex")}`,
    watch_dir: spaceDir,
  };
  const sql = createSql();
  await sql`INSERT INTO spaces (id, name, watch_dir) VALUES (${space.id}, ${space.name}, ${space.watch_dir})`;
  return space;
}

/**
 * Yield to the event loop a few times so any pending microtasks
 * (promise resolutions queued by `runAgentFn` returns) can drain
 * before we advance fake timers further.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("cron scheduler", () => {
  it("fires a tick at its scheduled time and schedules the next one", async () => {
    const space = await makeSpaceWithConfig(
      [
        "defaults:",
        "  provider: openai",
        "  model: gpt-5-mini",
        "roles:",
        "  writer:",
        `    cron: "* * * * *"`, // every minute
        "",
      ].join("\n"),
    );

    let invocations = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));

    const handle = await startScheduler({
      space,
      runAgentFn: async (): Promise<AgentRunResult> => {
        invocations++;
        return { skipped: false, edits: [], text: "", steps: 0 };
      },
    });

    // Advance to 00:01:00 — first cron firing for "* * * * *".
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(invocations).toBe(1);

    // Advance another minute — second tick should fire.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(invocations).toBe(2);

    await handle.stop();
  });

  it("per-space mutex skips a tick when another role's run is in flight", async () => {
    // Two roles in the same space, both with the same cron schedule.
    // Role A's runAgentFn hangs (we control its resolution); role B's
    // tick fires while A is mid-flight and should be SKIPPED, not
    // queued, not run in parallel.
    const space = await makeSpaceWithConfig(
      [
        "defaults:",
        "  provider: openai",
        "  model: gpt-5-mini",
        "roles:",
        "  role-a:",
        "    system: a",
        "    tools: [list_entities]",
        `    cron: "* * * * *"`,
        "  role-b:",
        "    system: b",
        "    tools: [list_entities]",
        `    cron: "* * * * *"`,
        "",
      ].join("\n"),
    );

    let aStartCount = 0;
    let bStartCount = 0;
    let releaseA!: () => void;
    const aBlocker = new Promise<void>((r) => {
      releaseA = r;
    });

    const runAgentFn = async (
      role: AgentRole,
      _input: AgentInput,
      _registry: ToolRegistry,
    ): Promise<AgentRunResult> => {
      if (role.name === "role-a") {
        aStartCount++;
        await aBlocker;
      } else {
        bStartCount++;
      }
      return { skipped: false, edits: [], text: "", steps: 0 };
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));

    const handle = await startScheduler({ space, runAgentFn });

    // Advance to first firing. Both roles' setTimeouts target the
    // same instant; both fire. Role A starts first (it's enumerated
    // first) and grabs the mutex; role B sees busy and skips.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(aStartCount).toBe(1);
    expect(bStartCount).toBe(0); // skipped because A holds the mutex

    // Release A so the run completes, freeing the mutex.
    releaseA();
    await flushMicrotasks();

    // Advance another minute. Role B's NEXT tick (the one it
    // rescheduled after the skip) should fire — and now the mutex
    // is free, so B actually runs this time.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(bStartCount).toBeGreaterThanOrEqual(1);

    await handle.stop();
  });

  it("stop() returns within gracePeriodMs even when a run is hanging", async () => {
    // Bounded-grace path: an in-flight run that never resolves must
    // not block daemon shutdown. stop() races inFlight against a
    // setTimeout(gracePeriodMs) and returns whichever wins.
    //
    // Setup ordering matters: enable fake timers BEFORE startScheduler
    // so the role's first setTimeout is queued against fake time and
    // can be advanced cheaply. Then for the actual stop() measurement
    // we switch back to real timers — the grace setTimeout is queued
    // INSIDE stop() (after the timer swap) so it uses real time.
    const space = await makeSpaceWithConfig(
      [
        "defaults:",
        "  provider: openai",
        "  model: gpt-5-mini",
        "roles:",
        "  role-hang:",
        "    system: hangs",
        "    tools: [list_entities]",
        `    cron: "* * * * *"`,
        "",
      ].join("\n"),
    );

    let started!: () => void;
    const hasStarted = new Promise<void>((r) => {
      started = r;
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));

    const handle = await startScheduler({
      space,
      runAgentFn: async (): Promise<AgentRunResult> => {
        started();
        return new Promise(() => {
          /* never resolves */
        });
      },
      gracePeriodMs: 150,
    });

    // Advance fake time to the first cron firing (00:01:00).
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Switch back to real timers BEFORE calling stop, so the grace
    // setTimeout queued inside stop() runs against real wall clock.
    vi.useRealTimers();

    // Confirm the run actually started — otherwise stop() takes the
    // !inFlight short-circuit and the test wouldn't exercise the
    // grace path.
    await hasStarted;

    const t0 = Date.now();
    await handle.stop();
    const elapsed = Date.now() - t0;

    // Bound: grace + a couple hundred ms of event-loop slack. If the
    // race never engaged, stop() would hang and hit the test timeout
    // instead.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_500);
  }, 10_000);

  it("does not schedule a role with no resolvable cron", async () => {
    // The bundled writer template ships a cron, but if the operator
    // explicitly overrides the role without re-supplying cron, the
    // role replacement is wholesale — cron is gone. Should be a
    // silent no-op, not a crash.
    const space = await makeSpaceWithConfig(
      [
        "defaults:",
        "  provider: openai",
        "  model: gpt-5-mini",
        "roles:",
        "  writer:",
        "    instructions: focus on history",
        "",
      ].join("\n"),
    );

    let invocations = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));

    const handle = await startScheduler({
      space,
      runAgentFn: async (): Promise<AgentRunResult> => {
        invocations++;
        return { skipped: false, edits: [], text: "", steps: 0 };
      },
    });

    // Advance two whole minutes; the role with no cron should never
    // have had a setTimeout to fire.
    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    await handle.stop();
    expect(invocations).toBe(0);
  });
});
