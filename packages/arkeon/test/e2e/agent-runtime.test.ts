// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2e tests for the agent runtime — focused on the contracts the
 * design hinges on:
 *
 *   - Read-gate: edit_file refuses paths not read_file'd in this run;
 *     reads invalidate after every successful edit.
 *   - Scheduler: cron-bearing roles fire on schedule and run through
 *     the per-space mutex.
 *
 * These don't boot the HTTP API — they exercise the runtime directly
 * against a fresh SQLite + tmp space.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../../src/schema/migrate.js";
import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import { removeByPath, syncFile, type Space } from "../../src/server/lib/sync.js";
import { _clearRecentMovesForTest } from "../../src/server/lib/recent-moves.js";
import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import { makeContext, readGateKey } from "../../src/server/agents/runtime.js";
import { startScheduler } from "../../src/server/agents/scheduler.js";
import type { Tool } from "ai";

let workdir: string;
let dbPath: string;
const SPACE: Space = { name: "rt-test", watch_dir: "" };

async function setupWorkdir() {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-rt-"));
  dbPath = join(workdir, "arke.db");
  SPACE.watch_dir = workdir;

  mkdirSync(join(workdir, "wiki"), { recursive: true });

  await runMigrations({ dbPath });
  initDb(dbPath);

  const sql = createSql();
  await sql`INSERT INTO spaces(name, watch_dir) VALUES(${SPACE.name}, ${workdir})`;
}

beforeEach(async () => {
  _clearRecentMovesForTest();
  await setupWorkdir();
});

afterEach(() => {
  closeDb();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("read-gate", () => {
  function getTool(name: string, ctx: ReturnType<typeof makeContext>): Tool {
    const factory = ALL_TOOLS[name];
    if (!factory) throw new Error(`unknown tool: ${name}`);
    return factory(ctx);
  }

  async function exec<T = unknown>(tool: Tool, input: unknown): Promise<T> {
    // The AI SDK's Tool surface carries provider-specific generics that
    // hide `execute` from the public type; call it directly. The runtime
    // contract is what defineTool wires up.
    type Exec = (input: unknown, ctx: { toolCallId: string; messages: unknown[] }) => Promise<T>;
    const fn = (tool as unknown as { execute: Exec }).execute;
    return fn(input, { toolCallId: "test", messages: [] });
  }

  it("edit_file refuses a path that wasn't read in this run", async () => {
    writeFileSync(join(workdir, "wiki/x.html"), `<!doctype html>
<meta charset="utf-8"><title>X</title>
<meta name="label" content="X">
<body><h1>X</h1><p>One.</p></body>`);
    await syncFile(SPACE, "wiki/x.html");

    const ctx = makeContext(SPACE, "writer");
    const edit = getTool("edit_file", ctx);

    await expect(
      exec(edit, {
        mode: "str_replace",
        path: "wiki/x.html",
        old_string: "One.",
        new_string: "Two.",
      }),
    ).rejects.toThrow(/must read_file/);
  });

  it("edit_file succeeds after a read, then fails on the next edit without a re-read", async () => {
    writeFileSync(join(workdir, "wiki/x.html"), `<!doctype html>
<meta charset="utf-8"><title>X</title>
<meta name="label" content="X">
<body><h1>X</h1><p>One.</p></body>`);
    await syncFile(SPACE, "wiki/x.html");

    const ctx = makeContext(SPACE, "writer");
    const read = getTool("read_file", ctx);
    const edit = getTool("edit_file", ctx);

    await exec(read, { path: "wiki/x.html" });
    expect(ctx.readPaths.has(readGateKey(SPACE.name, "wiki/x.html"))).toBe(true);

    // First edit: ok.
    await exec(edit, {
      mode: "str_replace",
      path: "wiki/x.html",
      old_string: "One.",
      new_string: "Two.",
    });
    // Successful edit invalidates the read.
    expect(ctx.readPaths.has(readGateKey(SPACE.name, "wiki/x.html"))).toBe(false);

    // Second edit without re-reading: fails.
    await expect(
      exec(edit, {
        mode: "str_replace",
        path: "wiki/x.html",
        old_string: "Two.",
        new_string: "Three.",
      }),
    ).rejects.toThrow(/must read_file/);

    // Re-read, then second edit succeeds.
    await exec(read, { path: "wiki/x.html" });
    await exec(edit, {
      mode: "str_replace",
      path: "wiki/x.html",
      old_string: "Two.",
      new_string: "Three.",
    });

    expect(readFileSync(join(workdir, "wiki/x.html"), "utf-8")).toContain("Three.");
  });

  it("create_file is terminal — no prior read required, doesn't touch the gate", async () => {
    const ctx = makeContext(SPACE, "writer");
    const create = getTool("create_file", ctx);

    await exec(create, {
      path: "wiki/new.html",
      label: "New",
      short_description: "y",
      body: "<h1>New</h1><p>x</p>",
    });

    expect(existsSync(join(workdir, "wiki/new.html"))).toBe(true);
    // Gate is untouched (create doesn't pre-load it).
    expect(ctx.readPaths.has(readGateKey(SPACE.name, "wiki/new.html"))).toBe(false);
  });

  it("insert_at_line invalidates the read (line numbers shifted)", async () => {
    writeFileSync(
      join(workdir, "wiki/x.html"),
      `<!doctype html>
<meta charset="utf-8"><title>X</title>
<meta name="label" content="X">
<body>
<h1>X</h1>
<p>One.</p>
</body>`,
    );
    await syncFile(SPACE, "wiki/x.html");

    const ctx = makeContext(SPACE, "writer");
    const read = getTool("read_file", ctx);
    const edit = getTool("edit_file", ctx);

    await exec(read, { path: "wiki/x.html" });
    await exec(edit, {
      mode: "insert_at_line",
      path: "wiki/x.html",
      line_number: 7,
      content: "<p>Inserted.</p>",
    });

    expect(ctx.readPaths.has(readGateKey(SPACE.name, "wiki/x.html"))).toBe(false);

    // Second edit must fail until re-read.
    await expect(
      exec(edit, {
        mode: "insert_at_line",
        path: "wiki/x.html",
        line_number: 8,
        content: "<p>Another.</p>",
      }),
    ).rejects.toThrow(/must read_file/);
  });
});

describe("move detection (#118)", () => {
  it("delete-then-create rename rewires inbound edges to the new path", async () => {
    // Two articles: A links to B. B gets renamed. A's edge should
    // follow B to its new path automatically.
    const bContent = `<!doctype html>
<meta charset="utf-8"><title>B</title>
<meta name="label" content="B">
<body><h1>B</h1></body>`;

    writeFileSync(join(workdir, "wiki/b.html"), bContent);
    writeFileSync(
      join(workdir, "wiki/a.html"),
      `<!doctype html>
<meta charset="utf-8"><title>A</title>
<meta name="label" content="A">
<body><h1>A</h1><p>see <a href="b.html">B</a></p></body>`,
    );
    await syncFile(SPACE, "wiki/b.html");
    await syncFile(SPACE, "wiki/a.html");

    const sql = createSql();
    let edge = await sql`
      SELECT target_path FROM relationships
      WHERE space_name = ${SPACE.name} AND source_path = 'wiki/a.html'
    `;
    expect(edge).toHaveLength(1);
    expect(edge[0].target_path).toBe("wiki/b.html");

    // Rename: delete old, create new with identical hash.
    rmSync(join(workdir, "wiki/b.html"));
    await removeByPath(SPACE, "wiki/b.html");
    writeFileSync(join(workdir, "wiki/b-renamed.html"), bContent);
    await syncFile(SPACE, "wiki/b-renamed.html");

    edge = await sql`
      SELECT target_path FROM relationships
      WHERE space_name = ${SPACE.name} AND source_path = 'wiki/a.html'
    `;
    expect(edge).toHaveLength(1);
    expect(edge[0].target_path).toBe("wiki/b-renamed.html");

    // And the red-link queue should not surface it.
    const reds = await sql`
      SELECT r.target_path
      FROM relationships r
      LEFT JOIN entities e ON e.space_name = r.space_name AND e.source_path = r.target_path
      WHERE r.space_name = ${SPACE.name} AND e.source_path IS NULL
    `;
    expect(reds).toHaveLength(0);
  });

  it("create-then-delete ordering (watcher reorder) still rewires correctly", async () => {
    const bContent = `<!doctype html>
<meta charset="utf-8"><title>B</title>
<meta name="label" content="B">
<body><h1>B</h1></body>`;

    writeFileSync(join(workdir, "wiki/b.html"), bContent);
    writeFileSync(
      join(workdir, "wiki/a.html"),
      `<!doctype html>
<meta charset="utf-8"><title>A</title>
<meta name="label" content="A">
<body><h1>A</h1><p>see <a href="b.html">B</a></p></body>`,
    );
    await syncFile(SPACE, "wiki/b.html");
    await syncFile(SPACE, "wiki/a.html");

    // Create-then-delete: a watcher could reorder these. We simulate
    // by creating the new file + sync first, then deleting the old.
    writeFileSync(join(workdir, "wiki/b-renamed.html"), bContent);
    await syncFile(SPACE, "wiki/b-renamed.html");
    rmSync(join(workdir, "wiki/b.html"));
    await removeByPath(SPACE, "wiki/b.html");

    const sql = createSql();
    const edge = await sql`
      SELECT target_path FROM relationships
      WHERE space_name = ${SPACE.name} AND source_path = 'wiki/a.html'
    `;
    expect(edge).toHaveLength(1);
    expect(edge[0].target_path).toBe("wiki/b-renamed.html");
  });

  it("genuine deletion (no matching create) leaves inbound edges as red links", async () => {
    const bContent = `<!doctype html>
<meta charset="utf-8"><title>B</title>
<meta name="label" content="B">
<body><h1>B</h1></body>`;
    writeFileSync(join(workdir, "wiki/b.html"), bContent);
    writeFileSync(
      join(workdir, "wiki/a.html"),
      `<!doctype html>
<meta charset="utf-8"><title>A</title>
<meta name="label" content="A">
<body><h1>A</h1><p>see <a href="b.html">B</a></p></body>`,
    );
    await syncFile(SPACE, "wiki/b.html");
    await syncFile(SPACE, "wiki/a.html");

    // Just delete; no replacement.
    rmSync(join(workdir, "wiki/b.html"));
    await removeByPath(SPACE, "wiki/b.html");

    const sql = createSql();
    const reds = await sql`
      SELECT r.target_path
      FROM relationships r
      LEFT JOIN entities e ON e.space_name = r.space_name AND e.source_path = r.target_path
      WHERE r.space_name = ${SPACE.name} AND e.source_path IS NULL
    `;
    expect(reds.map((r) => r.target_path)).toEqual(["wiki/b.html"]);
  });
});

describe("scheduler", () => {
  it("fires a cron-bearing role on schedule and invokes runAgent", async () => {
    // cron-parser supports a 6-field form where the first field is
    // seconds. `* * * * * *` → fire every second. Good enough to
    // observe one tick within the test's budget.
    const cron = "* * * * * *";

    // Per-space agents.yaml at .arkeon/agents.yaml drives the
    // scheduler's role list. Drop a minimal config that gives the
    // built-in `writer` template a fast cron and an API key so
    // buildAgentRole resolves cleanly.
    process.env.OPENAI_API_KEY = "sk-test-fake";
    mkdirSync(join(workdir, ".arkeon"), { recursive: true });
    writeFileSync(
      join(workdir, ".arkeon/agents.yaml"),
      `roles:\n  writer:\n    cron: "${cron}"\n`,
    );

    let invocations = 0;
    type RunAgentFn = Parameters<typeof startScheduler>[0]["runAgentFn"];
    const fakeRunAgent: RunAgentFn = async () => {
      invocations++;
      return { skipped: false, edits: [], text: "ok", steps: 1 };
    };

    const handle = await startScheduler({
      space: SPACE,
      scheduleRoles: ["writer"],
      runAgentFn: fakeRunAgent,
      gracePeriodMs: 200,
    });

    try {
      // Wait up to 2.5s — should see at least one firing.
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && invocations === 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(invocations).toBeGreaterThanOrEqual(1);
    } finally {
      await handle.stop();
      delete process.env.OPENAI_API_KEY;
    }
  }, 10_000);
});
