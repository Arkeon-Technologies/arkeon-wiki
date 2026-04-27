// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for the ripgrep-backed search endpoint.
 *
 * Spins up a SQLite DB + API server in-process, registers a temp
 * directory as a space, writes a few wiki files, and asserts that
 * GET /search returns ranked entity hits with snippets.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

const API_PORT = 18791;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;

function writeWiki(
  relativePath: string,
  properties: Record<string, unknown>,
  body: string,
): void {
  const absPath = join(testDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const fm = yaml
    .dump(properties, { schema: yaml.JSON_SCHEMA, sortKeys: false })
    .trimEnd();
  writeFileSync(absPath, `---\n${fm}\n---\n\n${body}\n`);
}

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (res.headers.get("content-type")?.includes("json")) {
    return res.json();
  }
  return res.text();
}

async function waitForEntityCount(
  expected: number,
  spaceId: string,
  timeoutMs = 5000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await api(`/entities?space_id=${spaceId}`);
    if ((data.entities ?? []).length === expected) return data.entities;
    await new Promise((r) => setTimeout(r, 200));
  }
  const data = await api(`/entities?space_id=${spaceId}`);
  return data.entities ?? [];
}

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-search-test-${randomBytes(4).toString("hex")}`);
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

  // Seed files BEFORE creating the space so reconciliation picks them up.
  writeWiki(
    "wiki/person/alan-turing.md",
    { label: "Alan Turing", subject_type: "person" },
    "Alan Turing was a British mathematician. Turing pioneered computer science.",
  );
  writeWiki(
    "wiki/person/claude-shannon.md",
    { label: "Claude Shannon", subject_type: "person" },
    "Claude Shannon was an American mathematician and the father of information theory.",
  );
  writeWiki(
    "wiki/concept/computability.md",
    { label: "Computability", subject_type: "concept" },
    "Computability theory was advanced by Alan Turing.",
  );

  const created = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "search-space", watch_dir: testDir }),
  });
  const space = (await created.json()) as { id: string };
  spaceId = space.id;

  await waitForEntityCount(3, spaceId);
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

describe("GET /search", () => {
  it("returns 400 when q is missing", async () => {
    const data = await api(`/search?space_id=${spaceId}`);
    expect(data.error?.code).toBe("validation_error");
  });

  it("finds wikis matching a literal query", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    expect(data.query).toBe("Turing");
    expect(data.hits.length).toBeGreaterThanOrEqual(2);

    const labels = data.hits.map((h: any) => h.label);
    expect(labels).toContain("Alan Turing");
    expect(labels).toContain("Computability");
  });

  it("ranks hits by match count", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    // Alan Turing's wiki mentions "Turing" at least twice (frontmatter + body),
    // Computability mentions it once.
    const turing = data.hits.find((h: any) => h.label === "Alan Turing");
    const computability = data.hits.find((h: any) => h.label === "Computability");
    expect(turing.match_count).toBeGreaterThan(computability.match_count);

    // First hit should be the higher-count one.
    expect(data.hits[0].label).toBe("Alan Turing");
  });

  it("returns snippets with line numbers", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=mathematician`);
    expect(data.hits.length).toBeGreaterThan(0);
    for (const hit of data.hits) {
      expect(Array.isArray(hit.snippets)).toBe(true);
      for (const snippet of hit.snippets) {
        expect(typeof snippet.line_number).toBe("number");
        expect(typeof snippet.text).toBe("string");
        expect(snippet.text.toLowerCase()).toContain("mathematician");
      }
    }
  });

  it("respects the limit parameter", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=mathematician&limit=1`);
    expect(data.hits).toHaveLength(1);
  });

  it("respects the snippets parameter", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&snippets=1`);
    for (const hit of data.hits) {
      expect(hit.snippets.length).toBeLessThanOrEqual(1);
    }
  });

  it("returns no hits for queries with no matches", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=zzznotpresentzzz`);
    expect(data.hits).toEqual([]);
  });

  it("searches all spaces when space_id is omitted", async () => {
    const data = await api(`/search?q=Shannon`);
    expect(data.hits.length).toBeGreaterThan(0);
    expect(data.hits.some((h: any) => h.label === "Claude Shannon")).toBe(true);
  });

  it("searches case-insensitively when query is lowercase (smart-case)", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=turing`);
    expect(data.hits.some((h: any) => h.label === "Alan Turing")).toBe(true);
  });
});
