// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for POST /contribute.
 *
 * Verifies the full round trip: the endpoint mutates frontmatter on disk,
 * syncFile() repopulates the contributions table, and subsequent calls
 * append rather than duplicate.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

const API_PORT = 18795;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;

async function api(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  return res.json();
}

async function postJson(path: string, body: unknown): Promise<any> {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

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

  const space = await postJson("/spaces", { name: "contrib-space", watch_dir: testDir });
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

describe("POST /contribute — placeholder creation", () => {
  it("creates a placeholder file when no matching wiki exists", async () => {
    const result = await postJson("/contribute", {
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
    const entities = await api(`/entities?space_id=${spaceId}`);
    const shannon = entities.entities.find((e: any) => e.label === "Claude Shannon");
    expect(shannon).toBeTruthy();
    expect(shannon.type).toBe("wiki");

    // Properties round-trip with status + contributions metadata
    const props = shannon.properties;
    expect(props.status).toBe("placeholder");
    expect(props.contributions).toHaveLength(1);
  });

  it("falls back to wiki/wiki/... when subject_type is missing", async () => {
    const result = await postJson("/contribute", {
      space_id: spaceId,
      subject: { label: "Some Vague Concept" },
      excerpt: "It's vague.",
    });

    expect(result.was_created).toBe(true);
    expect(result.wiki_path).toBe("wiki/wiki/some-vague-concept.md");
  });
});

describe("POST /contribute — exact-match routing", () => {
  it("appends to an existing wiki when label matches exactly", async () => {
    const first = await api(`/entities?space_id=${spaceId}`);
    const shannon = first.entities.find((e: any) => e.label === "Claude Shannon");
    const initialCount = (shannon.properties.contributions as unknown[]).length;

    const result = await postJson("/contribute", {
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
    const result = await postJson("/contribute", {
      space_id: spaceId,
      subject: { label: "  CLAUDE   SHANNON  ", subject_type: "person" },
      excerpt: "Yet another fact.",
    });
    expect(result.was_created).toBe(false);
  });

  it("matches against an existing wiki's aliases", async () => {
    // Manually author a wiki with aliases (simulating a hand-written entry).
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

    // Wait for the watcher to index it.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const entities = await api(`/entities?space_id=${spaceId}`);
      if (entities.entities.find((e: any) => e.label === "James Clerk Maxwell")) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const result = await postJson("/contribute", {
      space_id: spaceId,
      subject: { label: "JCM", subject_type: "person" },
      excerpt: "Maxwell unified electricity and magnetism.",
    });

    expect(result.was_created).toBe(false);
    expect(result.wiki_path).toBe(aliasWikiPath);
  });
});

describe("POST /contribute — source provenance", () => {
  it("links a contribution to a source entity when source_id is provided", async () => {
    // Create a source file via the watcher path.
    mkdirSync(join(testDir, "sources"), { recursive: true });
    writeFileSync(
      join(testDir, "sources/article.txt"),
      "An article about scientists.",
    );

    // Wait for the watcher to index it.
    let sourceEntity: any;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const entities = await api(`/entities?space_id=${spaceId}`);
      sourceEntity = entities.entities.find(
        (e: any) => e.source_path === "sources/article.txt",
      );
      if (sourceEntity) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sourceEntity).toBeTruthy();

    const result = await postJson("/contribute", {
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

  it("returns 404 when source_id does not exist in the space", async () => {
    const res = await fetch(`${BASE_URL}/contribute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space_id: spaceId,
        source_id: "01NONEXISTENT",
        subject: { label: "Whoever" },
        excerpt: "Some excerpt.",
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /contribute — validation", () => {
  it("rejects missing space_id", async () => {
    const res = await fetch(`${BASE_URL}/contribute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: { label: "X" },
        excerpt: "y",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing subject.label", async () => {
    const res = await fetch(`${BASE_URL}/contribute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space_id: spaceId,
        subject: {},
        excerpt: "y",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing excerpt", async () => {
    const res = await fetch(`${BASE_URL}/contribute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space_id: spaceId,
        subject: { label: "X" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown space_id", async () => {
    const res = await fetch(`${BASE_URL}/contribute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space_id: "01NONEXISTENT",
        subject: { label: "X" },
        excerpt: "y",
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /contribute — concurrency", () => {
  it("does not lose entries when the same wiki is targeted concurrently", async () => {
    // Build up 10 parallel contributions to the same wiki.
    const calls = Array.from({ length: 10 }, (_, i) =>
      postJson("/contribute", {
        space_id: spaceId,
        subject: { label: "Race Condition Test", subject_type: "person" },
        excerpt: `excerpt-${i}`,
      }),
    );

    const results = await Promise.all(calls);
    const wikiIds = new Set(results.map((r) => r.wiki_id));
    // All 10 calls land on the SAME wiki (one was_created=true, the rest false).
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
