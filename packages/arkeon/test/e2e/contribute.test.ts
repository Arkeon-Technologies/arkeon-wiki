// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the contribute() routing function.
 *
 * Spins up the full daemon stack (DB + watcher) so that file-based
 * fixtures (e.g. a hand-authored wiki used to verify alias matching)
 * sync naturally, but exercises contribute() directly rather than via
 * HTTP — there is no /contribute route. Verifies the round trip:
 * function call → frontmatter mutation → syncFile → SQLite mirror.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { contribute } from "../../src/server/lib/contributions.js";
import { ApiError } from "../../src/server/lib/errors.js";

const API_PORT = 18795;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;

function readFile(relativePath: string): string {
  return readFileSync(join(testDir, relativePath), "utf-8");
}

function parseFrontmatterFromFile(relativePath: string): Record<string, unknown> {
  const content = readFile(relativePath);
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No frontmatter in ${relativePath}`);
  return yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
}

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-contribute-${randomBytes(4).toString("hex")}`);
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

  // Register a space via HTTP (still public — that endpoint is fine to keep).
  const spaceRes = await fetch(`http://localhost:${API_PORT}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "contrib-space", watch_dir: testDir }),
  });
  const space = await spaceRes.json();
  spaceId = space.id;
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

async function getEntities(): Promise<any[]> {
  const res = await fetch(`http://localhost:${API_PORT}/entities?space_id=${spaceId}`);
  const data = await res.json();
  return data.entities ?? [];
}

describe("contribute() — placeholder creation", () => {
  it("creates a placeholder file when no matching wiki exists", async () => {
    const result = await contribute({
      space_id: spaceId,
      subject: { label: "Claude Shannon", subject_type: "person" },
      excerpt: "Shannon founded information theory.",
      claim: "founded information theory",
    });

    expect(result.was_created).toBe(true);
    expect(result.wiki_path).toBe("wiki/person/claude-shannon.md");
    expect(result.wiki_id).toBeTruthy();
    expect(result.contribution_id).toBeTruthy();

    expect(existsSync(join(testDir, result.wiki_path))).toBe(true);

    const fm = parseFrontmatterFromFile(result.wiki_path);
    expect(fm.id).toBe(result.wiki_id);
    expect(fm.label).toBe("Claude Shannon");
    expect(fm.subject_type).toBe("person");
    expect(fm.status).toBe("placeholder");

    const contributions = fm.contributions as Array<Record<string, unknown>>;
    expect(contributions).toHaveLength(1);
    expect(contributions[0].excerpt).toBe("Shannon founded information theory.");
    expect(contributions[0].claim).toBe("founded information theory");
    expect(contributions[0].id).toBe(result.contribution_id);
  });

  it("indexes the contribution in SQLite", async () => {
    const entities = await getEntities();
    const shannon = entities.find((e: any) => e.label === "Claude Shannon");
    expect(shannon).toBeTruthy();
    expect(shannon.type).toBe("wiki");

    const props = shannon.properties;
    expect(props.status).toBe("placeholder");
    expect(props.contributions).toHaveLength(1);
  });

  it("falls back to wiki/wiki/... when subject_type is missing", async () => {
    const result = await contribute({
      space_id: spaceId,
      subject: { label: "Some Vague Concept" },
      excerpt: "It's vague.",
    });

    expect(result.was_created).toBe(true);
    expect(result.wiki_path).toBe("wiki/wiki/some-vague-concept.md");
  });
});

describe("contribute() — exact-match routing", () => {
  it("appends to an existing wiki when label matches exactly", async () => {
    const before = await getEntities();
    const shannon = before.find((e: any) => e.label === "Claude Shannon");
    const initialCount = (shannon.properties.contributions as unknown[]).length;

    const result = await contribute({
      space_id: spaceId,
      subject: { label: "Claude Shannon", subject_type: "person" },
      excerpt: "He worked at Bell Labs from 1941.",
      claim: "joined Bell Labs in 1941",
    });

    expect(result.was_created).toBe(false);
    expect(result.wiki_id).toBe(shannon.id);
    expect(result.wiki_path).toBe(shannon.source_path);

    const fm = parseFrontmatterFromFile(result.wiki_path);
    const contributions = fm.contributions as Array<Record<string, unknown>>;
    expect(contributions).toHaveLength(initialCount + 1);
    expect(contributions[contributions.length - 1].excerpt).toBe(
      "He worked at Bell Labs from 1941.",
    );
  });

  it("matches case-insensitively and tolerates whitespace differences", async () => {
    const result = await contribute({
      space_id: spaceId,
      subject: { label: "  CLAUDE   SHANNON  ", subject_type: "person" },
      excerpt: "Yet another fact.",
    });
    expect(result.was_created).toBe(false);
  });

  it("matches against an existing wiki's aliases", async () => {
    // Author a wiki on disk; the watcher syncs it. Then contribute by alias.
    const aliasWikiPath = "wiki/person/jcm.md";
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    const fm = yaml
      .dump(
        {
          label: "James Clerk Maxwell",
          subject_type: "person",
          aliases: ["JCM", "J. C. Maxwell"],
        },
        { schema: yaml.JSON_SCHEMA, sortKeys: false },
      )
      .trimEnd();
    writeFileSync(
      join(testDir, aliasWikiPath),
      `---\n${fm}\n---\n\nMaxwell was a physicist.\n`,
    );

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const entities = await getEntities();
      if (entities.find((e: any) => e.label === "James Clerk Maxwell")) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const result = await contribute({
      space_id: spaceId,
      subject: { label: "JCM", subject_type: "person" },
      excerpt: "Maxwell unified electricity and magnetism.",
    });

    expect(result.was_created).toBe(false);
    expect(result.wiki_path).toBe(aliasWikiPath);
  });
});

describe("contribute() — source provenance", () => {
  it("links a contribution to a source entity when source_id is provided", async () => {
    mkdirSync(join(testDir, "sources"), { recursive: true });
    writeFileSync(
      join(testDir, "sources/article.txt"),
      "An article about scientists.",
    );

    let sourceEntity: any;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const entities = await getEntities();
      sourceEntity = entities.find(
        (e: any) => e.source_path === "sources/article.txt",
      );
      if (sourceEntity) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sourceEntity).toBeTruthy();

    const result = await contribute({
      space_id: spaceId,
      source_id: sourceEntity.id,
      subject: { label: "Some New Person", subject_type: "person" },
      excerpt: "They did something notable.",
    });

    expect(result.was_created).toBe(true);
    const fm = parseFrontmatterFromFile(result.wiki_path);
    const contributions = fm.contributions as Array<Record<string, unknown>>;
    expect(contributions[0].source_id).toBe(sourceEntity.id);
  });

  it("throws 404 when source_id does not exist in the space", async () => {
    await expect(
      contribute({
        space_id: spaceId,
        source_id: "01NONEXISTENT",
        subject: { label: "Whoever" },
        excerpt: "Some excerpt.",
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("contribute() — validation", () => {
  it("rejects missing space_id", async () => {
    await expect(
      contribute({
        space_id: "",
        subject: { label: "X" },
        excerpt: "y",
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
  });

  it("rejects missing subject.label", async () => {
    await expect(
      contribute({
        space_id: spaceId,
        subject: { label: "" },
        excerpt: "y",
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
  });

  it("rejects missing excerpt", async () => {
    await expect(
      contribute({
        space_id: spaceId,
        subject: { label: "X" },
        excerpt: "",
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
  });

  it("throws 404 for unknown space_id", async () => {
    await expect(
      contribute({
        space_id: "01NONEXISTENT",
        subject: { label: "X" },
        excerpt: "y",
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("contribute() — concurrency", () => {
  it("does not lose entries when the same wiki is targeted concurrently", async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      contribute({
        space_id: spaceId,
        subject: { label: "Race Condition Test", subject_type: "person" },
        excerpt: `excerpt-${i}`,
      }),
    );

    const results = await Promise.all(calls);
    const wikiIds = new Set(results.map((r) => r.wiki_id));
    expect(wikiIds.size).toBe(1);
    expect(results.filter((r) => r.was_created)).toHaveLength(1);

    const wikiPath = results[0].wiki_path;
    const fm = parseFrontmatterFromFile(wikiPath);
    const contributions = fm.contributions as Array<Record<string, unknown>>;
    expect(contributions).toHaveLength(10);

    const excerpts = new Set(contributions.map((c) => c.excerpt));
    for (let i = 0; i < 10; i++) {
      expect(excerpts.has(`excerpt-${i}`)).toBe(true);
    }
  });
});

describe("file-based contribution (no function call)", () => {
  it("auto-syncs contributions appended directly to a wiki's frontmatter", async () => {
    // The "external contributor" path: any agent with file access can
    // append a contribution by hand-editing the frontmatter array. The
    // watcher syncs it like any other change.
    mkdirSync(join(testDir, "wiki/person"), { recursive: true });
    const wikiPath = "wiki/person/ada-lovelace.md";
    const fm = yaml
      .dump(
        {
          label: "Ada Lovelace",
          subject_type: "person",
          contributions: [
            {
              id: "01HANDWRITTEN0000000000000",
              source_id: null,
              excerpt: "She wrote the first algorithm.",
              claim: null,
              added_at: "2026-04-27T00:00:00Z",
            },
          ],
        },
        { schema: yaml.JSON_SCHEMA, sortKeys: false },
      )
      .trimEnd();
    writeFileSync(
      join(testDir, wikiPath),
      `---\n${fm}\n---\n\nA mathematician.\n`,
    );

    // Wait for the watcher to sync.
    let ada: any;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const entities = await getEntities();
      ada = entities.find((e: any) => e.label === "Ada Lovelace");
      if (ada) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(ada).toBeTruthy();
    expect(ada.properties.contributions).toHaveLength(1);
    expect(ada.properties.contributions[0].id).toBe("01HANDWRITTEN0000000000000");
  });
});
