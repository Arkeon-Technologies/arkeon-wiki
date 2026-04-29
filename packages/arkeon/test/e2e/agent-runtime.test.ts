// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the agent runtime infrastructure: tool registry
 * (each tool's execute path) and the idempotency table.
 *
 * These tests don't call an LLM. They exercise the parts of the runtime
 * that the AI SDK doesn't already test: our tool wiring, our SQLite
 * roundtrip for agent_runs, and the integration between tools and
 * applyEdit.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import {
  alreadyProcessed,
  hashInput,
  makeContext,
  markProcessed,
} from "../../src/server/agents/runtime.js";
import { createSql } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";

const API_PORT = 18796;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let space: Space;

interface ExecutableTool {
  execute: (input: unknown) => Promise<unknown>;
}

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-agent-rt-${randomBytes(4).toString("hex")}`);
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
    body: JSON.stringify({ name: "agent-rt-space", watch_dir: testDir }),
  });
  const json = (await spaceRes.json()) as { id: string };

  space = { id: json.id, name: "agent-rt-space", watch_dir: testDir };
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

describe("agent_runs idempotency table", () => {
  beforeEach(async () => {
    const sql = createSql();
    await sql`DELETE FROM agent_runs`;
  });

  it("alreadyProcessed returns false when no row exists", async () => {
    const seen = await alreadyProcessed("any-role", { key: "k1", hash: "h1" });
    expect(seen).toBe(false);
  });

  it("markProcessed + alreadyProcessed roundtrip", async () => {
    await markProcessed("ingestor", { key: "src/a.md", hash: "abc" }, "completed", null);
    expect(
      await alreadyProcessed("ingestor", { key: "src/a.md", hash: "abc" }),
    ).toBe(true);
  });

  it("returns false when the hash differs (same key, new content)", async () => {
    await markProcessed("ingestor", { key: "src/a.md", hash: "abc" }, "completed", null);
    expect(
      await alreadyProcessed("ingestor", { key: "src/a.md", hash: "DIFFERENT" }),
    ).toBe(false);
  });

  it("returns false when the previous run failed (so we'll retry)", async () => {
    await markProcessed("editor", { key: "wiki-1", hash: "h" }, "failed", "boom");
    expect(await alreadyProcessed("editor", { key: "wiki-1", hash: "h" })).toBe(false);
  });

  it("upserts: a successful run after a failure flips to completed", async () => {
    await markProcessed("editor", { key: "wiki-1", hash: "h" }, "failed", "boom");
    await markProcessed("editor", { key: "wiki-1", hash: "h" }, "completed", null);
    expect(await alreadyProcessed("editor", { key: "wiki-1", hash: "h" })).toBe(true);
  });
});

describe("hashInput integration", () => {
  it("matches the same logical input regardless of object key order", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  });
});

describe("read_file tool", () => {
  it("reads a markdown file and returns parsed frontmatter", async () => {
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/person/turing.md"),
      "---\nlabel: Alan Turing\nsubject_type: person\n---\n\nMathematician.\n",
    );

    const ctx = makeContext(space, "test");
    const tool = ALL_TOOLS.read_file(ctx) as ExecutableTool;
    const result = (await tool.execute({ path: "wiki/person/turing.md" })) as {
      path: string;
      frontmatter: { label: string; subject_type: string };
      body: string;
    };

    expect(result.path).toBe("wiki/person/turing.md");
    expect(result.frontmatter.label).toBe("Alan Turing");
    expect(result.frontmatter.subject_type).toBe("person");
    expect(result.body).toContain("Mathematician.");
  });

  it("throws when the file does not exist", async () => {
    const ctx = makeContext(space, "test");
    const tool = ALL_TOOLS.read_file(ctx) as ExecutableTool;
    await expect(tool.execute({ path: "wiki/missing.md" })).rejects.toThrow(/does not exist/);
  });
});

describe("edit_file tool — CREATE mode (empty search, file does not exist)", () => {
  it("creates a new file and accumulates the edit on the context", async () => {
    const ctx = makeContext(space, "test");
    const tool = ALL_TOOLS.edit_file(ctx) as ExecutableTool;
    const result = (await tool.execute({
      path: "wiki/concept/note.md",
      search: "",
      replace: "---\nlabel: Note\nsubject_type: concept\n---\n\nbody\n",
    })) as { path: string; mode: string };

    expect(result.mode).toBe("create");
    expect(existsSync(join(testDir, "wiki/concept/note.md"))).toBe(true);
    expect(ctx.edits).toHaveLength(1);
    expect(ctx.edits[0].path).toBe("wiki/concept/note.md");
  });
});

describe("edit_file tool", () => {
  it("applies a SEARCH/REPLACE that matches exactly once", async () => {
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/person/lovelace.md"),
      "---\nlabel: Ada Lovelace\nsubject_type: person\n---\n\nA mathematician.\n",
    );

    const ctx = makeContext(space, "test");
    const tool = ALL_TOOLS.edit_file(ctx) as ExecutableTool;
    await tool.execute({
      path: "wiki/person/lovelace.md",
      search: "A mathematician.",
      replace: "A mathematician who wrote the first algorithm.",
    });

    const updated = readFileSync(join(testDir, "wiki/person/lovelace.md"), "utf-8");
    expect(updated).toContain("first algorithm");
  });

  it("rejects an edit whose SEARCH matches multiple times", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/concept/dup.md"),
      "---\nlabel: Dup\n---\n\nfoo\nfoo\n",
    );

    const ctx = makeContext(space, "test");
    const tool = ALL_TOOLS.edit_file(ctx) as ExecutableTool;
    await expect(
      tool.execute({ path: "wiki/concept/dup.md", search: "foo", replace: "bar" }),
    ).rejects.toThrow(/matched 2 times/);
  });

  it("rejects an edit whose SEARCH does not match", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/concept/miss.md"),
      "---\nlabel: Miss\n---\n\nbody\n",
    );

    const ctx = makeContext(space, "test");
    const tool = ALL_TOOLS.edit_file(ctx) as ExecutableTool;
    await expect(
      tool.execute({ path: "wiki/concept/miss.md", search: "absent", replace: "x" }),
    ).rejects.toThrow(/did not match/);
  });
});

describe("search tool", () => {
  it("returns hits for matching content in the space", async () => {
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/person/curie.md"),
      "---\nlabel: Marie Curie\nsubject_type: person\n---\n\nDiscovered radium and polonium.\n",
    );

    // Wait briefly for watcher to sync.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const sql = createSql();
      const rows =
        await sql`SELECT id FROM entities WHERE space_id = ${space.id} AND source_path = ${"wiki/person/curie.md"}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const ctx = makeContext(space, "test");
    const tool = ALL_TOOLS.search(ctx) as ExecutableTool;
    const result = (await tool.execute({ query: "polonium" })) as {
      hits: Array<{ label: string; source_path: string }>;
    };

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].label).toBe("Marie Curie");
  });
});
