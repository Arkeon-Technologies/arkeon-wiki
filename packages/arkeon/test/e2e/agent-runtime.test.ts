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
  await setupWorkdir();
});

afterEach(() => {
  closeDb();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

function getTool(name: string, ctx: ReturnType<typeof makeContext>): Tool {
  const factory = ALL_TOOLS[name];
  if (!factory) throw new Error(`unknown tool: ${name}`);
  return factory(ctx);
}

async function execTool<T = unknown>(tool: Tool, input: unknown): Promise<T> {
  // The AI SDK's Tool surface carries provider-specific generics that
  // hide `execute` from the public type; call it directly. The runtime
  // contract is what defineTool wires up.
  type Exec = (input: unknown, ctx: { toolCallId: string; messages: unknown[] }) => Promise<T>;
  const fn = (tool as unknown as { execute: Exec }).execute;
  return fn(input, { toolCallId: "test", messages: [] });
}

describe("read-gate", () => {
  const exec = execTool;

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
      html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>New</title><meta name="label" content="New"></head>
<body><h1>New</h1><p>x</p></body>
</html>`,
    });

    expect(existsSync(join(workdir, "wiki/new.html"))).toBe(true);
    // Gate is untouched (create doesn't pre-load it).
    expect(ctx.readPaths.has(readGateKey(SPACE.name, "wiki/new.html"))).toBe(false);
  });

  it("create_file rejects fragments without a wrapper and surfaces the template", async () => {
    const ctx = makeContext(SPACE, "writer");
    const create = getTool("create_file", ctx);

    await expect(
      exec(create, {
        path: "wiki/frag.html",
        html: "<h1>Frag</h1><p>no wrapper</p>",
      }),
    ).rejects.toThrow(/must be a complete HTML document.*<!DOCTYPE html>/s);
    expect(existsSync(join(workdir, "wiki/frag.html"))).toBe(false);
  });

  it("create_file rejects a document missing <meta charset>", async () => {
    const ctx = makeContext(SPACE, "writer");
    const create = getTool("create_file", ctx);

    await expect(
      exec(create, {
        path: "wiki/nocharset.html",
        html: `<!DOCTYPE html><html><head><title>X</title></head><body><h1>X</h1></body></html>`,
      }),
    ).rejects.toThrow(/must declare its encoding via <meta charset/);
    expect(existsSync(join(workdir, "wiki/nocharset.html"))).toBe(false);
  });

  it("create_file rejects a document missing <title>", async () => {
    const ctx = makeContext(SPACE, "writer");
    const create = getTool("create_file", ctx);

    await expect(
      exec(create, {
        path: "wiki/notitle.html",
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>X</h1></body></html>`,
      }),
    ).rejects.toThrow(/must contain a <title>/);
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

describe("get_entity tool", () => {
  type EdgeRow = { target_path?: string; source_path?: string; link_text: string | null };
  interface GetEntityFound {
    found: true;
    entity: {
      space_name: string;
      source_path: string;
      type: string;
      label: string | null;
      outbound: EdgeRow[];
      inbound: EdgeRow[];
    };
  }
  interface GetEntityMissing {
    found: false;
    path: string;
    space: string;
  }
  type GetEntityResult = GetEntityFound | GetEntityMissing;

  async function setupGraph() {
    // wiki/a.html  → wiki/b.html, sources/x.txt
    // wiki/b.html  → wiki/missing.html   (red link)
    // sources/x.txt is a source (type=file) that wiki/a cites.
    writeFileSync(
      join(workdir, "wiki/a.html"),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>A</title>
<meta name="label" content="A"></head>
<body><h1>A</h1>
<p>see <a href="b.html">B</a></p>
<p>cites <a href="../sources/x.txt">X</a></p>
</body></html>`,
    );
    writeFileSync(
      join(workdir, "wiki/b.html"),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>B</title>
<meta name="label" content="B"></head>
<body><h1>B</h1>
<p>see <a href="missing.html">missing</a></p>
</body></html>`,
    );
    mkdirSync(join(workdir, "sources"), { recursive: true });
    writeFileSync(join(workdir, "sources/x.txt"), "source content");

    await syncFile(SPACE, "wiki/a.html");
    await syncFile(SPACE, "wiki/b.html");
    await syncFile(SPACE, "sources/x.txt");
  }

  it("returns the entity with outbound + inbound edges", async () => {
    await setupGraph();
    const ctx = makeContext(SPACE, "writer");
    const tool = getTool("get_entity", ctx);

    const result = await execTool<GetEntityResult>(tool, { path: "wiki/b.html" });
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");

    expect(result.entity.source_path).toBe("wiki/b.html");
    expect(result.entity.type).toBe("wiki");
    expect(result.entity.label).toBe("B");
    expect(result.entity.outbound.map((e) => e.target_path)).toEqual([
      "wiki/missing.html",
    ]);
    expect(result.entity.inbound.map((e) => e.source_path)).toEqual([
      "wiki/a.html",
    ]);
    expect(result.entity.inbound[0]?.link_text).toBe("B");
  });

  it("a source's inbound list reveals every article that cites it", async () => {
    await setupGraph();
    const ctx = makeContext(SPACE, "writer");
    const tool = getTool("get_entity", ctx);

    const result = await execTool<GetEntityResult>(tool, {
      path: "sources/x.txt",
    });
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");

    expect(result.entity.type).toBe("file");
    expect(result.entity.outbound).toEqual([]);
    expect(result.entity.inbound.map((e) => e.source_path)).toEqual([
      "wiki/a.html",
    ]);
  });

  it("outbound preserves red-link targets that have no entity row", async () => {
    // wiki/b → wiki/missing.html. missing has no file → no entity.
    // get_entity('wiki/b.html').outbound still surfaces the target.
    await setupGraph();
    const ctx = makeContext(SPACE, "writer");
    const tool = getTool("get_entity", ctx);

    const result = await execTool<GetEntityResult>(tool, { path: "wiki/b.html" });
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");

    const targets = result.entity.outbound.map((e) => e.target_path);
    expect(targets).toContain("wiki/missing.html");
  });

  it("returns {found:false} for a path with no entity row", async () => {
    await setupGraph();
    const ctx = makeContext(SPACE, "writer");
    const tool = getTool("get_entity", ctx);

    const result = await execTool<GetEntityResult>(tool, {
      path: "wiki/missing.html",
    });
    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.path).toBe("wiki/missing.html");
    expect(result.space).toBe(SPACE.name);
  });

  it("strips leading slash and trailing #fragment / ?query", async () => {
    await setupGraph();
    const ctx = makeContext(SPACE, "writer");
    const tool = getTool("get_entity", ctx);

    for (const variant of [
      "/wiki/b.html",
      "wiki/b.html#open-threads",
      "wiki/b.html?v=2",
      "/wiki/b.html#x",
    ]) {
      const result = await execTool<GetEntityResult>(tool, { path: variant });
      expect(result.found, `variant "${variant}"`).toBe(true);
      if (!result.found) throw new Error("unreachable");
      expect(result.entity.source_path).toBe("wiki/b.html");
    }
  });

  it("does not interact with the read-gate (no read_file required)", async () => {
    await setupGraph();
    const ctx = makeContext(SPACE, "writer");
    const tool = getTool("get_entity", ctx);

    expect(ctx.readPaths.size).toBe(0);
    await execTool<GetEntityResult>(tool, { path: "wiki/a.html" });
    expect(ctx.readPaths.size).toBe(0);
  });
});

describe("deletion semantics", () => {
  it("deletion leaves inbound edges as red links (no auto-rewire on rename)", async () => {
    // Filesystem is the source of truth. When a target file is deleted —
    // whether genuinely gone or "renamed" by the user — the inbound
    // edges from articles still containing the old <a href> stay in the
    // index pointing at the now-missing path. They surface as red
    // links. A real rename is an explicit file-editing operation that
    // updates the source articles' hrefs; that's not auto-handled in v0.
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

    // Even if a new file with identical content lands at a different
    // path right after, the index does NOT auto-rewire. The edge in
    // a.html still has href="b.html" — that's the source of truth.
    writeFileSync(join(workdir, "wiki/b-renamed.html"), bContent);
    await syncFile(SPACE, "wiki/b-renamed.html");

    const edges = await sql`
      SELECT target_path FROM relationships
      WHERE space_name = ${SPACE.name} AND source_path = 'wiki/a.html'
    `;
    expect(edges.map((e) => e.target_path)).toEqual(["wiki/b.html"]);
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
