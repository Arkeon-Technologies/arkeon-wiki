// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 2: scripted-LLM tests for the agent runtime.
 *
 * Uses MockLanguageModelV3 from `ai/test` to drive runAgent through
 * deterministic tool-call sequences without an API key. Validates the
 * runtime contract: tool wiring, edit accumulation, idempotency lookup
 * and write, retry-on-failure, and the step-count cap.
 *
 * Together with agent-tools.test.ts (Layer 1, per-tool edge cases),
 * this gives the ingestor worker a runtime
 * they can build on without retesting the plumbing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

import { runAgent, type AgentRole } from "../../src/server/agents/runtime.js";
import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import { createSql } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";

const API_PORT = 18798;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let space: Space;

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-mockmodel-${randomBytes(4).toString("hex")}`);
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
    body: JSON.stringify({ name: "mockmodel-space", watch_dir: testDir }),
  });
  const json = (await spaceRes.json()) as { id: string };
  space = { id: json.id, name: "mockmodel-space", watch_dir: testDir };
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
  // Reset idempotency table between tests so each starts fresh.
  const sql = createSql();
  await sql`DELETE FROM agent_runs`;
});

// ── Mock helpers ──────────────────────────────────────────────────

function makeUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
}

function textStep(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: "stop",
    usage: makeUsage(),
    warnings: [],
  };
}

function toolCallStep(
  toolName: string,
  input: object,
  callId?: string,
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: callId ?? `call-${randomBytes(3).toString("hex")}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: "tool-calls",
    usage: makeUsage(),
    warnings: [],
  };
}

/**
 * Drive the model with a scripted sequence of generate results. Each
 * call to doGenerate returns the next step; running off the end throws.
 */
function scriptModel(steps: LanguageModelV3GenerateResult[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[i++];
      if (!step) {
        throw new Error(`mock model: no scripted response for call ${i}`);
      }
      return step;
    },
  });
}

// ── A reusable role for the runtime under test ────────────────────

function makeTestRole(overrides: Partial<AgentRole> = {}): AgentRole {
  return {
    name: "mock-test-role",
    model: { provider: "anthropic", id: "claude-test" }, // ignored: modelOverride wins
    tools: ["read_file", "edit_file", "search", "list_wikis"],
    buildPrompt: async () => ({ system: "you are a test", prompt: "do the thing" }),
    idempotencyKey: ({ triggerPath, meta }) => ({
      key: triggerPath ?? "default-key",
      hash: (meta?.hash as string) ?? "default-hash",
    }),
    concurrencyKey: ({ space: s }) => `mock-test-role::${s.id}`,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("runAgent — single-step text response", () => {
  it("completes with no edits when the model returns plain text", async () => {
    const model = scriptModel([textStep("nothing to do here")]);
    const result = await runAgent(makeTestRole(), { space }, ALL_TOOLS, {
      modelOverride: model,
    });

    expect(result.skipped).toBe(false);
    expect(result.text).toBe("nothing to do here");
    expect(result.edits).toEqual([]);
    expect(result.steps).toBe(1);
  });

  it("writes an agent_runs row with status='completed'", async () => {
    const model = scriptModel([textStep("ok")]);
    await runAgent(
      makeTestRole(),
      { space, triggerPath: "src/a", meta: { hash: "h-completed" } },
      ALL_TOOLS,
      { modelOverride: model },
    );

    const sql = createSql();
    const rows = await sql`
      SELECT status, input_hash FROM agent_runs
      WHERE role = ${"mock-test-role"} AND idempotency_key = ${"src/a"}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].input_hash).toBe("h-completed");
  });
});

describe("runAgent — tool-call loop", () => {
  it("dispatches one tool call, accumulates the edit, and finishes on text", async () => {
    const model = scriptModel([
      toolCallStep("edit_file", {
        path: "wiki/concept/from-mock.md",
        search: "",
        replace: "---\nlabel: From Mock\n---\n\nbody\n",
      }),
      textStep("file written"),
    ]);

    const result = await runAgent(makeTestRole(), { space }, ALL_TOOLS, {
      modelOverride: model,
    });

    expect(result.steps).toBe(2);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].path).toBe("wiki/concept/from-mock.md");
    expect(existsSync(join(testDir, "wiki/concept/from-mock.md"))).toBe(true);
  });

  it("composes multiple tools across steps (search → read → edit → text)", async () => {
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/person/galois.md"),
      "---\nlabel: Évariste Galois\nsubject_type: person\n---\n\nGroup theory.\n",
    );

    // wait for watcher
    const sql = createSql();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT id FROM entities WHERE space_id = ${space.id} AND label = ${"Évariste Galois"}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const model = scriptModel([
      toolCallStep("search", { query: "Group theory" }),
      toolCallStep("read_file", { path: "wiki/person/galois.md" }),
      toolCallStep("edit_file", {
        path: "wiki/person/galois.md",
        search: "Group theory.",
        replace: "Group theory. Founded the field before age 20.",
      }),
      textStep("edited"),
    ]);

    const result = await runAgent(makeTestRole(), { space }, ALL_TOOLS, {
      modelOverride: model,
    });

    expect(result.steps).toBe(4);
    // edit_file mutates; search and read don't.
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].path).toBe("wiki/person/galois.md");

    // Verify the edit actually landed.
    const fm = readFileSync(join(testDir, "wiki/person/galois.md"), "utf-8");
    expect(fm).toContain("Founded the field before age 20.");
  });

  it("continues the loop even when a tool errors — error becomes a tool result", async () => {
    // The first tool call targets a missing file; the LLM should see
    // the error and recover. The runtime must not abort the run.
    const model = scriptModel([
      toolCallStep("read_file", { path: "wiki/does-not-exist.md" }),
      textStep("recovered: file was missing"),
    ]);

    const result = await runAgent(makeTestRole(), { space }, ALL_TOOLS, {
      modelOverride: model,
    });

    expect(result.skipped).toBe(false);
    expect(result.steps).toBe(2);
    expect(result.text).toContain("recovered");
  });
});

describe("runAgent — idempotency", () => {
  it("skips on replay (same key + same hash, previous status='completed')", async () => {
    const role = makeTestRole();
    const input = { space, triggerPath: "src/idem-1", meta: { hash: "h-1" } };

    await runAgent(role, input, ALL_TOOLS, {
      modelOverride: scriptModel([textStep("first")]),
    });

    // The replay shouldn't even reach the (single-shot) mock model.
    const result = await runAgent(role, input, ALL_TOOLS, {
      modelOverride: scriptModel([]),
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("already_processed");
  });

  it("re-runs on a new hash for the same key (content changed)", async () => {
    const role = makeTestRole();
    const trigger = "src/idem-2";

    await runAgent(role, { space, triggerPath: trigger, meta: { hash: "v1" } }, ALL_TOOLS, {
      modelOverride: scriptModel([textStep("v1")]),
    });

    const result = await runAgent(
      role,
      { space, triggerPath: trigger, meta: { hash: "v2" } },
      ALL_TOOLS,
      { modelOverride: scriptModel([textStep("v2")]) },
    );

    expect(result.skipped).toBe(false);
    expect(result.text).toBe("v2");
  });

  it("retries when the previous run is recorded as 'failed'", async () => {
    const role = makeTestRole();
    const input = { space, triggerPath: "src/idem-3", meta: { hash: "h-3" } };

    // First: model throws, run is marked failed.
    await expect(
      runAgent(role, input, ALL_TOOLS, {
        modelOverride: new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error("simulated provider error");
          },
        }),
      }),
    ).rejects.toThrow(/simulated provider/);

    const sql = createSql();
    let rows = await sql`
      SELECT status FROM agent_runs
      WHERE role = ${role.name} AND idempotency_key = ${"src/idem-3"}
    `;
    expect(rows[0].status).toBe("failed");

    // Second: succeed; the failed row should not block the retry.
    const result = await runAgent(role, input, ALL_TOOLS, {
      modelOverride: scriptModel([textStep("retry succeeded")]),
    });

    expect(result.skipped).toBe(false);
    expect(result.text).toBe("retry succeeded");

    rows = await sql`
      SELECT status FROM agent_runs
      WHERE role = ${role.name} AND idempotency_key = ${"src/idem-3"}
    `;
    expect(rows[0].status).toBe("completed");
  });
});

describe("runAgent — provider error handling", () => {
  it("marks the run failed and re-throws when the model errors", async () => {
    const role = makeTestRole();
    const input = { space, triggerPath: "src/err", meta: { hash: "h-err" } };

    await expect(
      runAgent(role, input, ALL_TOOLS, {
        modelOverride: new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error("provider went pop");
          },
        }),
      }),
    ).rejects.toThrow(/provider went pop/);

    const sql = createSql();
    const rows = await sql`
      SELECT status, error FROM agent_runs
      WHERE role = ${role.name} AND idempotency_key = ${"src/err"}
    `;
    expect(rows[0].status).toBe("failed");
    expect((rows[0].error as string) ?? "").toMatch(/provider went pop/);
  });
});

describe("runAgent — step cap", () => {
  it("stops after maxSteps when the model never emits a stop", async () => {
    // Model that never stops calling edit_file CREATE with unique paths.
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i++;
        return toolCallStep("edit_file", {
          path: `wiki/concept/loop-${i}.md`,
          search: "",
          replace: `---\nlabel: Loop ${i}\n---\n\nbody\n`,
        });
      },
    });

    const role = makeTestRole({ maxSteps: 3 });
    const result = await runAgent(role, { space, triggerPath: "src/cap" }, ALL_TOOLS, {
      modelOverride: model,
    });

    // The loop is bounded: at most maxSteps model calls.
    expect(result.steps).toBeLessThanOrEqual(3);
    // And the edits accumulated reflect that bound.
    expect(result.edits.length).toBeLessThanOrEqual(3);
  });
});
