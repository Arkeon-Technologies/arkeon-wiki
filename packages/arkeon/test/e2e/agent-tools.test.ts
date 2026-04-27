// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 1: deep edge-case coverage for each tool, invoked directly
 * (no LLM, no AI SDK loop). Pairs with agent-runtime.test.ts which
 * covers the happy paths.
 *
 * Goals:
 *   - Every documented failure mode produces a recognizable error
 *   - Path traversal / absolute-path inputs are rejected uniformly
 *   - Tools compose: write → read, write → edit, search → read
 *   - Idempotent operations are actually idempotent
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import { makeContext } from "../../src/server/agents/runtime.js";
import { createSql } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";

const API_PORT = 18797;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let space: Space;

interface ExecutableTool {
  execute: (input: unknown) => Promise<unknown>;
}

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-tools-${randomBytes(4).toString("hex")}`);
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
    body: JSON.stringify({ name: "tools-space", watch_dir: testDir }),
  });
  const json = (await spaceRes.json()) as { id: string };
  space = { id: json.id, name: "tools-space", watch_dir: testDir };
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

function tool(name: keyof typeof ALL_TOOLS): ExecutableTool {
  const ctx = makeContext(space, "tool-test");
  return ALL_TOOLS[name](ctx) as ExecutableTool;
}

function toolWithCtx(name: keyof typeof ALL_TOOLS) {
  const ctx = makeContext(space, "tool-test");
  return { tool: ALL_TOOLS[name](ctx) as ExecutableTool, ctx };
}

// ── path safety (cross-tool) ──────────────────────────────────────

describe("path safety", () => {
  it.each([
    ["../etc/passwd"],
    ["../../something"],
    ["wiki/../../../escape"],
  ])("read_file rejects path '%s' that escapes the watch dir", async (path) => {
    await expect(tool("read_file").execute({ path })).rejects.toThrow(/escapes/);
  });

  it.each([
    ["/etc/passwd"],
    ["/Users/anyone/file.md"],
  ])("read_file rejects absolute path '%s'", async (path) => {
    await expect(tool("read_file").execute({ path })).rejects.toThrow(/absolute/);
  });

  it("write_file rejects path that escapes the watch dir", async () => {
    await expect(
      tool("write_file").execute({ path: "../leak.txt", content: "x" }),
    ).rejects.toThrow(/escapes/);
  });

  it("write_file rejects absolute path", async () => {
    await expect(
      tool("write_file").execute({ path: "/tmp/leak.txt", content: "x" }),
    ).rejects.toThrow(/absolute/);
  });

  it("edit_file rejects path that escapes the watch dir", async () => {
    await expect(
      tool("edit_file").execute({
        path: "../leak.txt",
        search: "x",
        replace: "y",
      }),
    ).rejects.toThrow(/escapes/);
  });
});

// ── read_file ─────────────────────────────────────────────────────

describe("read_file edge cases", () => {
  it("returns raw content for non-markdown files", async () => {
    mkdirSync(join(testDir, "sources"), { recursive: true });
    writeFileSync(join(testDir, "sources/article.txt"), "plain text body");

    const result = (await tool("read_file").execute({
      path: "sources/article.txt",
    })) as { path: string; content: string };

    expect(result.content).toBe("plain text body");
    expect((result as { frontmatter?: unknown }).frontmatter).toBeUndefined();
  });

  it("returns empty frontmatter for markdown without a frontmatter block", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(join(testDir, "wiki/concept/no-fm.md"), "just a body\n");

    const result = (await tool("read_file").execute({
      path: "wiki/concept/no-fm.md",
    })) as { frontmatter: Record<string, unknown>; body: string };

    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("just a body");
  });

  it("throws when the path is a directory", async () => {
    await expect(tool("read_file").execute({ path: "wiki" })).rejects.toThrow(
      /is a directory/,
    );
  });

  it("reads an empty file as empty content", async () => {
    writeFileSync(join(testDir, "sources/empty.txt"), "");
    const result = (await tool("read_file").execute({
      path: "sources/empty.txt",
    })) as { content: string };
    expect(result.content).toBe("");
  });
});

// ── write_file ────────────────────────────────────────────────────

describe("write_file edge cases", () => {
  it("overwrites an existing file", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(join(testDir, "wiki/concept/over.md"), "old");

    await tool("write_file").execute({
      path: "wiki/concept/over.md",
      content: "---\nlabel: Over\n---\n\nnew body\n",
    });

    expect(readFileSync(join(testDir, "wiki/concept/over.md"), "utf-8")).toContain(
      "new body",
    );
  });

  it("creates intermediate directories", async () => {
    await tool("write_file").execute({
      path: "wiki/deep/nested/new.md",
      content: "---\nlabel: Deep\n---\n\nbody\n",
    });
    expect(existsSync(join(testDir, "wiki/deep/nested/new.md"))).toBe(true);
  });

  it("accumulates edits on the context across multiple writes", async () => {
    const { tool: t, ctx } = toolWithCtx("write_file");
    await t.execute({ path: "wiki/concept/a.md", content: "---\nlabel: A\n---\n" });
    await t.execute({ path: "wiki/concept/b.md", content: "---\nlabel: B\n---\n" });
    expect(ctx.edits).toHaveLength(2);
    expect(ctx.edits.map((e) => e.path)).toEqual([
      "wiki/concept/a.md",
      "wiki/concept/b.md",
    ]);
  });
});

// ── edit_file ─────────────────────────────────────────────────────

describe("edit_file edge cases", () => {
  it("handles multi-line SEARCH/REPLACE", async () => {
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/person/multi.md"),
      "---\nlabel: Multi\n---\n\nLine one.\nLine two.\nLine three.\n",
    );

    await tool("edit_file").execute({
      path: "wiki/person/multi.md",
      search: "Line one.\nLine two.",
      replace: "Lines one and two, merged.",
    });

    const updated = readFileSync(
      join(testDir, "wiki/person/multi.md"),
      "utf-8",
    );
    expect(updated).toContain("Lines one and two, merged.");
    expect(updated).not.toContain("Line one.");
  });

  it("treats regex special characters in SEARCH as literal", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/concept/special.md"),
      "---\nlabel: S\n---\n\nUse a.+regex? pattern here.\n",
    );

    await tool("edit_file").execute({
      path: "wiki/concept/special.md",
      search: "a.+regex? pattern",
      replace: "a literal phrase",
    });

    expect(
      readFileSync(join(testDir, "wiki/concept/special.md"), "utf-8"),
    ).toContain("a literal phrase");
  });

  it("can delete a span by replacing with the empty string", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/concept/del.md"),
      "---\nlabel: D\n---\n\nKeep this. DELETE THIS. Keep this too.\n",
    );

    await tool("edit_file").execute({
      path: "wiki/concept/del.md",
      search: " DELETE THIS.",
      replace: "",
    });

    const updated = readFileSync(join(testDir, "wiki/concept/del.md"), "utf-8");
    expect(updated).not.toContain("DELETE THIS");
    expect(updated).toContain("Keep this. Keep this too.");
  });

  it("rejects an empty SEARCH", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/concept/empty-search.md"),
      "---\nlabel: E\n---\n\nbody\n",
    );

    await expect(
      tool("edit_file").execute({
        path: "wiki/concept/empty-search.md",
        search: "",
        replace: "x",
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      tool("edit_file").execute({
        path: "wiki/missing.md",
        search: "x",
        replace: "y",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("applies two consecutive edits on the same file", async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/concept/two-edits.md"),
      "---\nlabel: TE\n---\n\nfirst SECOND third.\n",
    );

    const { tool: t } = toolWithCtx("edit_file");
    await t.execute({
      path: "wiki/concept/two-edits.md",
      search: "first",
      replace: "FIRST",
    });
    await t.execute({
      path: "wiki/concept/two-edits.md",
      search: "third",
      replace: "THIRD",
    });

    expect(
      readFileSync(join(testDir, "wiki/concept/two-edits.md"), "utf-8"),
    ).toContain("FIRST SECOND THIRD.");
  });
});

// ── contribute ────────────────────────────────────────────────────

describe("contribute edge cases", () => {
  it("routes to an existing wiki via alias match", async () => {
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/person/feynman.md"),
      `---\nlabel: Richard Feynman\nsubject_type: person\naliases:\n  - Dick Feynman\n  - R.P. Feynman\n---\n\nPhysicist.\n`,
    );

    // wait for watcher
    const sql = createSql();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT id FROM entities WHERE space_id = ${space.id} AND label = ${"Richard Feynman"}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const result = (await tool("contribute").execute({
      subject: { label: "R.P. Feynman", subject_type: "person" },
      excerpt: "Diagrams.",
    })) as { was_created: boolean; wiki_path: string };

    expect(result.was_created).toBe(false);
    expect(result.wiki_path).toBe("wiki/person/feynman.md");
  });

  it("propagates source_id into the frontmatter contribution", async () => {
    mkdirSync(join(testDir, "sources"), { recursive: true });
    writeFileSync(
      join(testDir, "sources/origin.txt"),
      "An interesting article.",
    );

    const sql = createSql();
    const deadline = Date.now() + 5000;
    let sourceId: string | null = null;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT id FROM entities WHERE space_id = ${space.id} AND source_path = ${"sources/origin.txt"}`;
      if (rows.length > 0) {
        sourceId = rows[0].id as string;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sourceId).toBeTruthy();

    const result = (await tool("contribute").execute({
      subject: { label: "Sourced Subject", subject_type: "concept" },
      excerpt: "From a real source.",
      source_id: sourceId!,
    })) as { wiki_path: string };

    const fm = readFileSync(join(testDir, result.wiki_path), "utf-8");
    expect(fm).toContain(`source_id: ${sourceId}`);
  });

  it("does not lose entries when ten parallel contribute calls hit the same new label", async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      tool("contribute").execute({
        subject: { label: "Tool Layer Race", subject_type: "person" },
        excerpt: `tool-excerpt-${i}`,
      }),
    );

    const results = (await Promise.all(calls)) as Array<{
      wiki_path: string;
      was_created: boolean;
    }>;

    const created = results.filter((r) => r.was_created).length;
    expect(created).toBe(1);

    const wikiPath = results[0].wiki_path;
    const fm = readFileSync(join(testDir, wikiPath), "utf-8");
    for (let i = 0; i < 10; i++) {
      expect(fm).toContain(`tool-excerpt-${i}`);
    }
  });
});

// ── search ────────────────────────────────────────────────────────

describe("search edge cases", () => {
  beforeAll(async () => {
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });
    writeFileSync(
      join(testDir, "wiki/concept/redox.md"),
      `---\nlabel: Redox Reactions\nsubject_type: concept\n---\n\nElectron transfer in chemistry.\n`,
    );
    writeFileSync(
      join(testDir, "wiki/concept/oxidation.md"),
      `---\nlabel: Oxidation\nsubject_type: concept\n---\n\nLoss of electrons.\n`,
    );

    // wait for watcher to index both
    const sql = createSql();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT id FROM entities WHERE space_id = ${space.id} AND source_path IN (${"wiki/concept/redox.md"}, ${"wiki/concept/oxidation.md"})`;
      if (rows.length === 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 15_000);

  it("returns an empty hits array when nothing matches", async () => {
    const result = (await tool("search").execute({
      query: "definitely-not-present-in-any-file-xyzzy",
    })) as { hits: unknown[] };
    expect(result.hits).toEqual([]);
  });

  it("supports regex mode", async () => {
    const result = (await tool("search").execute({
      query: "electron[s]?",
      regex: true,
    })) as { hits: Array<{ source_path: string }> };

    const paths = result.hits.map((h) => h.source_path).sort();
    expect(paths).toContain("wiki/concept/oxidation.md");
    expect(paths).toContain("wiki/concept/redox.md");
  });

  it("honours the limit parameter", async () => {
    const result = (await tool("search").execute({
      query: "electron",
      limit: 1,
    })) as { hits: unknown[] };
    expect(result.hits.length).toBeLessThanOrEqual(1);
  });
});

// ── list_wikis ────────────────────────────────────────────────────

describe("list_wikis edge cases", () => {
  // Seed a small corpus the tool can filter against.
  beforeAll(async () => {
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    mkdirSync(join(testDir, "wiki/organization"), { recursive: true });

    writeFileSync(
      join(testDir, "wiki/person/babbage.md"),
      `---\nlabel: Charles Babbage\nsubject_type: person\nstatus: published\n---\n\nMechanical engine pioneer.\n`,
    );
    writeFileSync(
      join(testDir, "wiki/person/babb-noted.md"),
      `---\nlabel: Babb Noted\nsubject_type: person\nstatus: placeholder\n---\n\n`,
    );
    writeFileSync(
      join(testDir, "wiki/organization/bell-labs.md"),
      `---\nlabel: Bell Labs\nsubject_type: organization\nstatus: published\n---\n\nResearch lab.\n`,
    );

    // Wait for watcher to index all three.
    const sql = createSql();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT id FROM entities
        WHERE space_id = ${space.id}
          AND source_path IN (
            ${"wiki/person/babbage.md"},
            ${"wiki/person/babb-noted.md"},
            ${"wiki/organization/bell-labs.md"}
          )
      `;
      if (rows.length === 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 15_000);

  it("filters by subject_type", async () => {
    const result = (await tool("list_wikis").execute({
      subject_type: "organization",
    })) as { wikis: Array<{ label: string }>; total: number };

    const labels = result.wikis.map((w) => w.label);
    expect(labels).toContain("Bell Labs");
    expect(labels).not.toContain("Charles Babbage");
  });

  it("filters by status (placeholder vs published)", async () => {
    const result = (await tool("list_wikis").execute({
      status: "placeholder",
    })) as { wikis: Array<{ label: string }> };

    expect(result.wikis.map((w) => w.label)).toContain("Babb Noted");
    expect(result.wikis.map((w) => w.label)).not.toContain("Charles Babbage");
  });

  it("matches label_prefix case-insensitively, prefix-anchored only", async () => {
    // Prefix 'BABB' (all caps) should match 'Babb Noted' (case-insensitive,
    // starts with Babb) but NOT 'Charles Babbage' (starts with Charles).
    const result = (await tool("list_wikis").execute({
      label_prefix: "BABB",
    })) as { wikis: Array<{ label: string }> };

    const labels = result.wikis.map((w) => w.label);
    expect(labels).toContain("Babb Noted");
    expect(labels).not.toContain("Charles Babbage");
  });

  it("escapes LIKE wildcards in label_prefix so '%' matches literally", async () => {
    // No wikis whose label literally starts with '%', so the result must
    // be empty — proves '%' is not interpreted as a wildcard.
    const result = (await tool("list_wikis").execute({
      label_prefix: "%",
    })) as { wikis: unknown[] };
    expect(result.wikis).toEqual([]);
  });

  it("returns has_contributions=true wikis when contributions are pending", async () => {
    // Add a placeholder via contribute(), which leaves a pending contribution
    // attached to a fresh wiki.
    await tool("contribute").execute({
      subject: { label: "List Wikis Pending", subject_type: "concept" },
      excerpt: "demo excerpt",
    });

    const result = (await tool("list_wikis").execute({
      has_contributions: true,
    })) as { wikis: Array<{ label: string }> };

    expect(result.wikis.map((w) => w.label)).toContain("List Wikis Pending");
  });

  it("attaches counts when include_counts is true", async () => {
    const result = (await tool("list_wikis").execute({
      label_prefix: "List Wikis Pending",
      include_counts: true,
    })) as {
      wikis: Array<{
        label: string;
        counts?: { contributions_pending: number; incoming_links: number; outgoing_links: number };
      }>;
    };

    const w = result.wikis.find((x) => x.label === "List Wikis Pending");
    expect(w).toBeTruthy();
    expect(w!.counts).toBeDefined();
    expect(w!.counts!.contributions_pending).toBeGreaterThanOrEqual(1);
  });

  it("respects limit", async () => {
    const result = (await tool("list_wikis").execute({
      limit: 1,
    })) as { wikis: unknown[]; total: number };

    expect(result.wikis.length).toBeLessThanOrEqual(1);
    expect(result.total).toBeGreaterThan(1);
  });

  it("respects offset for pagination", async () => {
    const page1 = (await tool("list_wikis").execute({
      limit: 1,
      offset: 0,
      sort: "label",
    })) as { wikis: Array<{ id: string }> };

    const page2 = (await tool("list_wikis").execute({
      limit: 1,
      offset: 1,
      sort: "label",
    })) as { wikis: Array<{ id: string }> };

    expect(page1.wikis[0].id).not.toBe(page2.wikis[0].id);
  });

  it("does not return source files (only wikis)", async () => {
    mkdirSync(join(testDir, "sources"), { recursive: true });
    writeFileSync(
      join(testDir, "sources/listwikis-source.txt"),
      "should never appear in list_wikis",
    );

    const sql = createSql();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT id FROM entities WHERE source_path = ${"sources/listwikis-source.txt"}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const result = (await tool("list_wikis").execute({
      label_prefix: "listwikis",
    })) as { wikis: Array<{ source_path: string }> };

    expect(result.wikis.find((w) => w.source_path?.startsWith("sources/"))).toBeUndefined();
  });
});

// ── cross-tool composition ────────────────────────────────────────

describe("cross-tool composition", () => {
  it("write → read returns the content we just wrote", async () => {
    const { tool: w } = toolWithCtx("write_file");
    await w.execute({
      path: "wiki/concept/wr-read.md",
      content: "---\nlabel: WR-Read\n---\n\nbody from compose test\n",
    });

    const r = tool("read_file");
    const result = (await r.execute({ path: "wiki/concept/wr-read.md" })) as {
      frontmatter: { label: string };
      body: string;
    };
    expect(result.frontmatter.label).toBe("WR-Read");
    expect(result.body).toContain("body from compose test");
  });

  it("write → edit modifies what we just wrote", async () => {
    await tool("write_file").execute({
      path: "wiki/concept/wr-edit.md",
      content: "---\nlabel: WR-Edit\n---\n\noriginal phrase here\n",
    });
    await tool("edit_file").execute({
      path: "wiki/concept/wr-edit.md",
      search: "original phrase",
      replace: "amended phrase",
    });

    expect(
      readFileSync(join(testDir, "wiki/concept/wr-edit.md"), "utf-8"),
    ).toContain("amended phrase");
  });

  it("contribute → read shows the appended frontmatter entry", async () => {
    const c = (await tool("contribute").execute({
      subject: { label: "Compose Subject", subject_type: "concept" },
      excerpt: "first excerpt",
    })) as { wiki_path: string };

    const r = (await tool("read_file").execute({ path: c.wiki_path })) as {
      frontmatter: { contributions: Array<{ excerpt: string }> };
    };

    expect(r.frontmatter.contributions).toHaveLength(1);
    expect(r.frontmatter.contributions[0].excerpt).toBe("first excerpt");
  });
});
