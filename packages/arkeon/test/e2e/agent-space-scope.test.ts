// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for per-role space scoping (issue #99).
 *
 * Spins up the API + sync stack, registers two spaces side-by-side,
 * and exercises the multi-space code paths in the agent tools:
 *
 *   - read_file requires `space` on a multi-space role
 *   - read_file rejects a `space` outside the allowed set
 *   - search fans out across both spaces by default and tags hits
 *   - list_entities fans out and tags rows with `space` and `space_id`
 *   - resolveAllowedSpaces actually pulls live rows out of SQLite
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import { makeContext } from "../../src/server/agents/runtime.js";
import { resolveAllowedSpaces } from "../../src/server/agents/space-scope.js";
import type { Space } from "../../src/server/lib/sync.js";

const API_PORT = 18797;

let baseDir: string;
let dirA: string;
let dirB: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceA: Space;
let spaceB: Space;

interface ExecutableTool {
  execute: (input: unknown) => Promise<unknown>;
}

beforeAll(async () => {
  baseDir = join(tmpdir(), `arkeon-scope-${randomBytes(4).toString("hex")}`);
  dirA = join(baseDir, "repo-a");
  dirB = join(baseDir, "repo-b");
  stateDir = join(baseDir, "state");
  for (const d of [dirA, dirB, join(stateDir, "data")]) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirA, "wiki/person"), { recursive: true });
  mkdirSync(join(dirB, "wiki/person"), { recursive: true });

  // Pre-seed each space with a wiki so search has something to find.
  // We write before space registration so the initial sync picks them
  // up — the test doesn't have to wait for a watcher event.
  writeFileSync(
    join(dirA, "wiki/person/turing.md"),
    "---\nlabel: Alan Turing\nsubject_type: person\n---\n\nMathematician in space A.\n",
  );
  writeFileSync(
    join(dirB, "wiki/person/lovelace.md"),
    "---\nlabel: Ada Lovelace\nsubject_type: person\n---\n\nMathematician in space B.\n",
  );

  process.env.ARKEON_WIKI_HOME = stateDir;
  // Disable chunking + embeddings — keyword search is enough for this
  // suite, and the embedder warm-up otherwise dominates the first run.
  process.env.ARKEON_WIKI_CHUNKING = "0";
  process.env.ARKEON_WIKI_EMBEDDINGS = "0";

  const dbFile = join(stateDir, "data", "arke.db");
  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: API_PORT, dbPath: dbFile });
  serverHandle = { stop: async () => apiHandle.stop() };

  // Register two spaces side-by-side. The route does an initial scan
  // so by the time the response lands, the wikis we wrote above are
  // entities.
  for (const [name, watch_dir] of [
    ["scope-a", dirA],
    ["scope-b", dirB],
  ] as const) {
    const res = await fetch(`http://localhost:${API_PORT}/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, watch_dir }),
    });
    const json = (await res.json()) as { id: string };
    if (name === "scope-a") {
      spaceA = { id: json.id, name, watch_dir };
    } else {
      spaceB = { id: json.id, name, watch_dir };
    }
  }
}, 30_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (baseDir && existsSync(baseDir)) {
    rmSync(baseDir, { recursive: true, force: true });
  }
}, 30_000);

describe("resolveAllowedSpaces against live SQLite", () => {
  it("returns just `self` when scope omitted", async () => {
    const result = await resolveAllowedSpaces(undefined, spaceA);
    expect(result.map((s) => s.id)).toEqual([spaceA.id]);
  });

  it("expands `*` to every registered space", async () => {
    const result = await resolveAllowedSpaces(["*"], spaceA);
    const ids = new Set(result.map((s) => s.id));
    expect(ids.has(spaceA.id)).toBe(true);
    expect(ids.has(spaceB.id)).toBe(true);
  });

  it("resolves a sibling by name", async () => {
    const result = await resolveAllowedSpaces(["self", "scope-b"], spaceA);
    expect(result.map((s) => s.id)).toEqual([spaceA.id, spaceB.id]);
  });

  it("resolves a sibling by id", async () => {
    const result = await resolveAllowedSpaces(["self", spaceB.id], spaceA);
    expect(result.map((s) => s.id)).toEqual([spaceA.id, spaceB.id]);
  });
});

describe("read_file with multi-space scope", () => {
  it("reads from a sibling space when `space` is passed", async () => {
    const ctx = makeContext(spaceA, "bridge", { allowedSpaces: [spaceA, spaceB] });
    const tool = ALL_TOOLS.read_file(ctx) as ExecutableTool;
    const result = (await tool.execute({
      path: "wiki/person/lovelace.md",
      space: "scope-b",
    })) as { path: string; space: string; space_id: string; body: string };

    expect(result.space_id).toBe(spaceB.id);
    expect(result.space).toBe("scope-b");
    expect(result.body).toContain("Mathematician in space B");
  });

  it("requires `space` when the role is multi-space", async () => {
    const ctx = makeContext(spaceA, "bridge", { allowedSpaces: [spaceA, spaceB] });
    const tool = ALL_TOOLS.read_file(ctx) as ExecutableTool;
    await expect(
      tool.execute({ path: "wiki/person/turing.md" }),
    ).rejects.toThrow(/space.*required/i);
  });

  it("rejects a `space` outside the allowed set", async () => {
    const ctx = makeContext(spaceA, "ingestor", { allowedSpaces: [spaceA] });
    const tool = ALL_TOOLS.read_file(ctx) as ExecutableTool;
    await expect(
      tool.execute({ path: "wiki/person/lovelace.md", space: "scope-b" }),
    ).rejects.toThrow(/not in the allowed set/);
  });

  it("works without `space` for a single-space role (no behaviour change)", async () => {
    const ctx = makeContext(spaceA, "ingestor"); // defaults to [spaceA]
    const tool = ALL_TOOLS.read_file(ctx) as ExecutableTool;
    const result = (await tool.execute({ path: "wiki/person/turing.md" })) as {
      space_id: string;
      body: string;
    };
    expect(result.space_id).toBe(spaceA.id);
    expect(result.body).toContain("space A");
  });
});

describe("search fan-out across allowed spaces", () => {
  it("returns hits from both spaces tagged with `space` and `space_id`", async () => {
    const ctx = makeContext(spaceA, "bridge", { allowedSpaces: [spaceA, spaceB] });
    const tool = ALL_TOOLS.search(ctx) as ExecutableTool;
    const result = (await tool.execute({
      query: "Mathematician",
      mode: "keyword",
    })) as {
      keyword: {
        hits: Array<{ space_id: string; space: string; source_path: string }>;
      };
      spaces: Array<{ id: string; name: string }>;
    };

    expect(result.spaces.map((s) => s.id).sort()).toEqual(
      [spaceA.id, spaceB.id].sort(),
    );
    const hitSpaceIds = new Set(result.keyword.hits.map((h) => h.space_id));
    expect(hitSpaceIds.has(spaceA.id)).toBe(true);
    expect(hitSpaceIds.has(spaceB.id)).toBe(true);
    for (const hit of result.keyword.hits) {
      expect(["scope-a", "scope-b"]).toContain(hit.space);
    }
  });

  it("scopes to a single space when `space` is supplied", async () => {
    const ctx = makeContext(spaceA, "bridge", { allowedSpaces: [spaceA, spaceB] });
    const tool = ALL_TOOLS.search(ctx) as ExecutableTool;
    const result = (await tool.execute({
      query: "Mathematician",
      mode: "keyword",
      space: "scope-b",
    })) as { keyword: { hits: Array<{ space_id: string }> } };

    expect(result.keyword.hits.length).toBeGreaterThan(0);
    for (const hit of result.keyword.hits) {
      expect(hit.space_id).toBe(spaceB.id);
    }
  });
});

describe("list_entities fan-out", () => {
  it("returns rows from every allowed space and tags each", async () => {
    const ctx = makeContext(spaceA, "bridge", { allowedSpaces: [spaceA, spaceB] });
    const tool = ALL_TOOLS.list_entities(ctx) as ExecutableTool;
    const result = (await tool.execute({ type: "wiki" })) as {
      entities: Array<{ space_id: string; space: string; label: string }>;
      spaces: Array<{ id: string; name: string }>;
    };

    const ids = new Set(result.entities.map((e) => e.space_id));
    expect(ids.has(spaceA.id)).toBe(true);
    expect(ids.has(spaceB.id)).toBe(true);
    for (const e of result.entities) {
      expect(["scope-a", "scope-b"]).toContain(e.space);
    }
    expect(result.spaces.map((s) => s.id).sort()).toEqual(
      [spaceA.id, spaceB.id].sort(),
    );
  });

  it("scopes to a single space when `space` is supplied", async () => {
    const ctx = makeContext(spaceA, "bridge", { allowedSpaces: [spaceA, spaceB] });
    const tool = ALL_TOOLS.list_entities(ctx) as ExecutableTool;
    const result = (await tool.execute({ type: "wiki", space: spaceB.id })) as {
      entities: Array<{ space_id: string }>;
    };

    expect(result.entities.length).toBeGreaterThan(0);
    for (const e of result.entities) {
      expect(e.space_id).toBe(spaceB.id);
    }
  });

  it("rejects a `space` outside the allowed set", async () => {
    const ctx = makeContext(spaceA, "ingestor", { allowedSpaces: [spaceA] });
    const tool = ALL_TOOLS.list_entities(ctx) as ExecutableTool;
    await expect(
      tool.execute({ type: "wiki", space: "scope-b" }),
    ).rejects.toThrow(/not in the allowed set/);
  });
});
