// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for the declarative trigger system.
 *
 * Drives the full plumbing:
 *   - agents.yaml declares a custom synthesizer role with a
 *     `path_under: wiki/**` trigger and `by_role_not: [synthesizer]`
 *     loop safety.
 *   - The ingestor edits a wiki via applyEdit({role: "ingestor"}).
 *   - The scheduler observes the edit, looks up the latest by_role
 *     from entity_latest_edit, and fires the synthesizer (because
 *     the path matches and the latest editor wasn't the synthesizer).
 *   - The synthesizer runs (a mock runAgent) and edits the same wiki
 *     with role: "synthesizer".
 *   - A second edit attempt by the synthesizer is filtered out — its
 *     own writes don't fire it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { applyEdit } from "../../src/server/lib/file-edits.js";
import { closeDb, createSql } from "../../src/server/lib/sql.js";
import { generateUlid } from "../../src/server/lib/ids.js";
import { runMigrations } from "../../src/schema/index.js";
import { startScheduler } from "../../src/server/agents/scheduler.js";

let testDir: string;
let stateDir: string;
let space: { id: string; name: string; watch_dir: string };
let prevEmbeddingsEnv: string | undefined;
let prevChunkingEnv: string | undefined;
let prevOpenaiKey: string | undefined;

beforeAll(async () => {
  // Save before mutating — vitest e2e config has isolate: false, so
  // sibling suites in the same process share process.env.
  prevEmbeddingsEnv = process.env.ARKEON_WIKI_EMBEDDINGS;
  prevChunkingEnv = process.env.ARKEON_WIKI_CHUNKING;
  prevOpenaiKey = process.env.OPENAI_API_KEY;
  process.env.ARKEON_WIKI_EMBEDDINGS = "0";
  process.env.ARKEON_WIKI_CHUNKING = "0";

  const base = join(tmpdir(), `arkeon-cascade-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "wiki", "person"), { recursive: true });
  mkdirSync(join(testDir, ".arkeon"), { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });

  // agents.yaml that wires up a custom synthesizer with attribution-
  // gated triggers and replaces the ingestor's default trigger with
  // a narrower one (sources/** only, so writing wikis directly via
  // applyEdit doesn't accidentally fire the ingestor too).
  writeFileSync(
    join(testDir, ".arkeon/agents.yaml"),
    [
      "defaults:",
      "  provider: openai",
      "  model: gpt-5.4",
      "roles:",
      "  ingestor:",
      "    triggers:",
      "      - on: file_changed",
      "        path_under: ['sources/**']",
      "        by_role_not: ['ingestor']",
      "  synthesizer:",
      "    system: 'you synthesize wikis'",
      "    user: 'synthesize {{trigger_path}}'",
      "    tools: ['read_file', 'edit_file']",
      "    triggers:",
      "      - on: file_changed",
      "        path_under: ['wiki/**/*.md']",
      "        by_role_not: ['synthesizer']",
      "",
    ].join("\n"),
  );

  // The agent runtime needs an api key to build roles — fake one for
  // the test (the scheduler's probe-build doesn't actually call the
  // model, only constructs the AgentRole).
  process.env.OPENAI_API_KEY = "sk-fake-for-test";

  process.env.DATABASE_PATH = join(stateDir, "data", "arke.db");
  await runMigrations({ dbPath: process.env.DATABASE_PATH });

  space = { id: generateUlid(), name: "cascade-test", watch_dir: testDir };
  const sql = createSql();
  await sql`INSERT INTO spaces (id, name, watch_dir) VALUES (${space.id}, ${space.name}, ${space.watch_dir})`;
}, 30_000);

afterAll(async () => {
  closeDb();
  if (testDir) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
  if (prevEmbeddingsEnv === undefined) delete process.env.ARKEON_WIKI_EMBEDDINGS;
  else process.env.ARKEON_WIKI_EMBEDDINGS = prevEmbeddingsEnv;
  if (prevChunkingEnv === undefined) delete process.env.ARKEON_WIKI_CHUNKING;
  else process.env.ARKEON_WIKI_CHUNKING = prevChunkingEnv;
  if (prevOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevOpenaiKey;
}, 10_000);

describe("trigger cascade — ingestor edit fires synthesizer; synthesizer edit does not refire itself", () => {
  it("ingestor edit on wiki/** enqueues a synthesizer run; synthesizer's own edits do not", async () => {
    const fakeSynthesizer = vi.fn(async (role, _input, _registry) => ({
      skipped: false,
      edits: [],
      text: "ok",
      steps: 0,
      usage: undefined,
    }));

    // Run the scheduler with only the synthesizer worker active —
    // ingestor's worker would attempt to call OpenAI on its run path,
    // which we don't want here. Restrict to synthesizer; we call
    // applyEdit directly to simulate the ingestor's effect.
    const scheduler = await startScheduler({
      space,
      triggerRoles: ["synthesizer"],
      runAgentFn: fakeSynthesizer,
    });

    try {
      // Ingestor writes a wiki — this is the "ingestor finished
      // editing" event the scheduler will observe.
      await applyEdit(
        space,
        {
          kind: "write",
          path: "wiki/person/shannon.md",
          content: [
            "---",
            "label: Claude Shannon",
            "subject_type: person",
            "---",
            "",
            "Claude Shannon was the father of information theory.",
            "",
          ].join("\n"),
        },
        { role: "ingestor", edit_kind: "create" },
      );

      // Notify the scheduler — in production the watcher does this.
      await scheduler.notify("wiki/person/shannon.md");

      // Wait for the synthesizer worker to drain.
      await waitFor(() => fakeSynthesizer.mock.calls.length > 0, 3000);

      expect(fakeSynthesizer).toHaveBeenCalledTimes(1);
      expect(fakeSynthesizer.mock.calls[0][0].name).toBe("synthesizer");
      expect(fakeSynthesizer.mock.calls[0][1].triggerPath).toBe(
        "wiki/person/shannon.md",
      );

      // Now simulate the synthesizer's own write to the same file.
      await applyEdit(
        space,
        {
          kind: "edit",
          path: "wiki/person/shannon.md",
          search: "father of information theory",
          replace: "father of information theory and Bell Labs engineer",
        },
        { role: "synthesizer", edit_kind: "replace" },
      );

      const callsBefore = fakeSynthesizer.mock.calls.length;

      // Notify again. This time the latest by_role on the wiki is
      // "synthesizer", so the synthesizer's own trigger filters it out.
      await scheduler.notify("wiki/person/shannon.md");

      // Give the worker a beat to do nothing.
      await new Promise((r) => setTimeout(r, 300));

      expect(fakeSynthesizer.mock.calls.length).toBe(callsBefore);

      // Queue should also be empty — nothing got enqueued.
      const sql = createSql();
      const queueRows = await sql`
        SELECT id FROM agent_queue WHERE space_id = ${space.id}
      ` as { id: number }[];
      expect(queueRows).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });
});

async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}
