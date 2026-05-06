// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for the builtin consolidator's declarative trigger.
 *
 * The consolidator is the first builtin role to use *positive*
 * attribution (`by_role: ["ingestor"]`) on top of negative loop-safety
 * (`by_role_not: ["consolidator"]`). This exercises that combination
 * end-to-end:
 *
 *   1. Ingestor edits a wiki     → consolidator fires (by_role match)
 *   2. Consolidator edits a wiki → consolidator does NOT refire
 *                                  (by_role_not blocks)
 *   3. Human edits a wiki        → consolidator does NOT fire
 *                                  (by_role positive filter rejects
 *                                   the "human" / null attribution)
 *
 * As in trigger-cascade.test.ts, we drive scheduler.notify() directly
 * with an injected fake runAgent — the real LLM path isn't exercised
 * here, just the trigger plumbing.
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
  prevEmbeddingsEnv = process.env.ARKEON_WIKI_EMBEDDINGS;
  prevChunkingEnv = process.env.ARKEON_WIKI_CHUNKING;
  prevOpenaiKey = process.env.OPENAI_API_KEY;
  process.env.ARKEON_WIKI_EMBEDDINGS = "0";
  process.env.ARKEON_WIKI_CHUNKING = "0";

  const base = join(tmpdir(), `arkeon-consolidator-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "wiki", "concept"), { recursive: true });
  mkdirSync(join(testDir, ".arkeon"), { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });

  // Narrow the ingestor's trigger so direct applyEdit({role: "ingestor"})
  // calls in the test (which simulate post-source ingestion writes) don't
  // re-fire the ingestor itself when scheduler.notify is called. The
  // consolidator's own builtin trigger is left unmodified — that's what
  // we're testing.
  writeFileSync(
    join(testDir, ".arkeon/agents.yaml"),
    [
      "defaults:",
      "  provider: openai",
      "  model: gpt-mock",
      "roles:",
      "  ingestor:",
      "    triggers:",
      "      - on: file_changed",
      "        path_under: ['sources/**']",
      "        by_role_not: ['ingestor']",
      "",
    ].join("\n"),
  );

  process.env.OPENAI_API_KEY = "sk-fake-for-test";
  process.env.DATABASE_PATH = join(stateDir, "data", "arke.db");
  await runMigrations({ dbPath: process.env.DATABASE_PATH });

  space = { id: generateUlid(), name: "consolidator-test", watch_dir: testDir };
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

describe("consolidator trigger — by_role positive attribution + loop safety", () => {
  it("fires on ingestor's wiki edit; not on consolidator's own; not on human's", async () => {
    const fakeConsolidator = vi.fn(async (_role, _input, _registry) => ({
      skipped: false,
      edits: [],
      text: "ok",
      steps: 0,
      usage: undefined,
    }));

    const scheduler = await startScheduler({
      space,
      // Only the consolidator worker runs — the ingestor's worker
      // would attempt to call OpenAI on its own queue, which we don't
      // need to exercise here.
      triggerRoles: ["consolidator"],
      runAgentFn: fakeConsolidator,
    });

    try {
      const wikiPath = "wiki/concept/lust.md";

      // ── 1. Ingestor edits a wiki ─────────────────────────────────
      // applyEdit stamps by_role=ingestor on the entity_edits row
      // syncFile inserts.
      await applyEdit(
        space,
        {
          kind: "write",
          path: wikiPath,
          content: [
            "---",
            "label: Lust",
            "subject_type: concept",
            "---",
            "",
            "Disordered desire.",
            "",
          ].join("\n"),
        },
        { role: "ingestor", edit_kind: "create" },
      );
      await scheduler.notify(wikiPath);
      await waitFor(() => fakeConsolidator.mock.calls.length > 0, 3000);

      expect(fakeConsolidator).toHaveBeenCalledTimes(1);
      expect(fakeConsolidator.mock.calls[0][0].name).toBe("consolidator");
      expect(fakeConsolidator.mock.calls[0][1].triggerPath).toBe(wikiPath);

      // ── 2. Consolidator's own edit ───────────────────────────────
      // Stamps by_role=consolidator. The consolidator's by_role_not
      // filter must reject this and the worker must not fire again.
      await applyEdit(
        space,
        {
          kind: "edit",
          path: wikiPath,
          search: "Disordered desire.",
          replace: "Disordered desire — see [Lust](/wiki/concept/lust.md).",
        },
        { role: "consolidator", edit_kind: "replace" },
      );
      const callsAfterIngestor = fakeConsolidator.mock.calls.length;
      await scheduler.notify(wikiPath);
      await new Promise((r) => setTimeout(r, 300));
      expect(fakeConsolidator.mock.calls.length).toBe(callsAfterIngestor);

      // ── 3. Human edit (no edit-context registered) ───────────────
      // syncFile sees no edit-context for this path and attributes
      // the change to "human". The consolidator's positive `by_role:
      // ["ingestor"]` filter must reject "human", so the worker does
      // not fire. This is the case the consolidator distinguishes
      // from the older negative-only synthesizer pattern: an explicit
      // human edit on a wiki does not provoke a consolidation pass.
      const humanFile = join(testDir, wikiPath);
      const { readFileSync, writeFileSync: write } = await import("node:fs");
      const current = readFileSync(humanFile, "utf-8");
      write(humanFile, current + "\nA human added this line.\n", "utf-8");
      // syncFile (driven by the watcher in production; called directly
      // here) records the human-attributed entity_edits row.
      const { syncFile } = await import("../../src/server/lib/sync.js");
      await syncFile(space, wikiPath);

      const callsAfterConsolidator = fakeConsolidator.mock.calls.length;
      await scheduler.notify(wikiPath);
      await new Promise((r) => setTimeout(r, 300));
      expect(fakeConsolidator.mock.calls.length).toBe(callsAfterConsolidator);

      // Queue is empty — nothing got enqueued for cases 2 or 3.
      const sql = createSql();
      const queueRows = (await sql`
        SELECT id FROM agent_queue WHERE space_id = ${space.id}
      `) as { id: number }[];
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
