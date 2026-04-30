// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for the /search endpoint (issue #47).
 *
 * Spins up a SQLite DB + API server in-process, registers a temp
 * directory as a space, writes a few wiki files, and asserts that
 * GET /search returns the namespaced response with whichever strategy
 * the caller asked for. Forces ARKEON_WIKI_EMBEDDER=mock so vector
 * search exercises the pipeline without depending on Ollama.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { waitForDrain } from "../../src/server/lib/embedding-queue.js";
import { resetEmbedder } from "../../src/server/lib/embedder/index.js";

const API_PORT = 18791;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;
const prevEmbedderEnv = process.env.ARKEON_WIKI_EMBEDDER;

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

async function waitForWikiCount(
  expected: number,
  spaceId: string,
  timeoutMs = 5000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await api(`/wikis?space_id=${spaceId}`);
    if ((data.wikis ?? []).length === expected) return data.wikis;
    await new Promise((r) => setTimeout(r, 200));
  }
  const data = await api(`/wikis?space_id=${spaceId}`);
  return data.wikis ?? [];
}

beforeAll(async () => {
  process.env.ARKEON_WIKI_EMBEDDER = "mock";

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

  await waitForWikiCount(3, spaceId);
  // Vector search needs embeddings; mock embedder fills them deterministically.
  await waitForDrain(15_000);
}, 30_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
  if (prevEmbedderEnv === undefined) {
    delete process.env.ARKEON_WIKI_EMBEDDER;
  } else {
    process.env.ARKEON_WIKI_EMBEDDER = prevEmbedderEnv;
  }
  resetEmbedder();
}, 30_000);

describe("GET /search — validation + envelope", () => {
  it("returns 400 when q is missing", async () => {
    const data = await api(`/search?space_id=${spaceId}`);
    expect(data.error?.code).toBe("validation_error");
  });

  it("returns 400 when mode is unrecognised", async () => {
    const data = await api(`/search?q=foo&mode=fancy`);
    expect(data.error?.code).toBe("validation_error");
  });

  it("defaults mode to both", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    expect(data.mode).toBe("both");
    expect(data.keyword).toBeDefined();
    expect(data.vector).toBeDefined();
  });

  it("namespaces results under the strategy that ran", async () => {
    const k = await api(`/search?space_id=${spaceId}&q=Turing&mode=keyword`);
    expect(k.keyword).toBeDefined();
    expect(k.vector).toBeUndefined();

    const v = await api(`/search?space_id=${spaceId}&q=Turing&mode=vector`);
    expect(v.vector).toBeDefined();
    expect(v.keyword).toBeUndefined();
  });
});

describe("GET /search?mode=keyword", () => {
  it("finds wikis matching a literal query", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&mode=keyword`);
    expect(data.query).toBe("Turing");
    expect(data.keyword.hits.length).toBeGreaterThanOrEqual(2);

    const labels = data.keyword.hits.map((h: any) => h.label);
    expect(labels).toContain("Alan Turing");
    expect(labels).toContain("Computability");
  });

  it("ranks hits by match count", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&mode=keyword`);
    const turing = data.keyword.hits.find((h: any) => h.label === "Alan Turing");
    const computability = data.keyword.hits.find((h: any) => h.label === "Computability");
    expect(turing.match_count).toBeGreaterThan(computability.match_count);
    expect(data.keyword.hits[0].label).toBe("Alan Turing");
  });

  it("returns snippets with line numbers", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=mathematician&mode=keyword`);
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    for (const hit of data.keyword.hits) {
      expect(Array.isArray(hit.snippets)).toBe(true);
      for (const snippet of hit.snippets) {
        expect(typeof snippet.line_number).toBe("number");
        expect(typeof snippet.text).toBe("string");
        expect(snippet.text.toLowerCase()).toContain("mathematician");
      }
    }
  });

  it("respects the limit parameter", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=mathematician&mode=keyword&limit=1`,
    );
    expect(data.keyword.hits).toHaveLength(1);
  });

  it("respects the snippets parameter", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=keyword&snippets=1`,
    );
    for (const hit of data.keyword.hits) {
      expect(hit.snippets.length).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty hits for queries with no matches", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=zzznotpresentzzz&mode=keyword`,
    );
    expect(data.keyword.hits).toEqual([]);
  });

  it("searches all spaces when space_id is omitted", async () => {
    const data = await api(`/search?q=Shannon&mode=keyword`);
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    expect(data.keyword.hits.some((h: any) => h.label === "Claude Shannon")).toBe(true);
  });

  it("searches case-insensitively when query is lowercase (smart-case)", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=turing&mode=keyword`);
    expect(data.keyword.hits.some((h: any) => h.label === "Alan Turing")).toBe(true);
  });
});

describe("GET /search?mode=vector", () => {
  it("returns chunk-level hits with similarity scores", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&mode=vector`);
    expect(data.vector).toBeDefined();
    expect(data.vector.model).toBe("mock@256");
    expect(data.vector.hits.length).toBeGreaterThan(0);

    for (const hit of data.vector.hits) {
      expect(typeof hit.entity_id).toBe("string");
      expect(typeof hit.chunk_id).toBe("number");
      expect(typeof hit.heading_path).toBe("string");
      expect(typeof hit.text).toBe("string");
      expect(typeof hit.similarity).toBe("number");
      expect(hit.similarity).toBeLessThanOrEqual(1);
    }
  });

  it("orders hits by similarity descending", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&mode=vector`);
    const sims = data.vector.hits.map((h: any) => h.similarity);
    const sorted = [...sims].sort((a, b) => b - a);
    expect(sims).toEqual(sorted);
  });

  it("scopes to a space when space_id is set", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&mode=vector`);
    for (const hit of data.vector.hits) {
      expect(hit.space_id).toBe(spaceId);
    }
  });

  it("respects the limit parameter", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=anything&mode=vector&limit=2`,
    );
    expect(data.vector.hits.length).toBeLessThanOrEqual(2);
  });

  it("returns the same chunk_id for repeated identical queries (mock determinism)", async () => {
    const a = await api(`/search?space_id=${spaceId}&q=stable-query&mode=vector&limit=1`);
    const b = await api(`/search?space_id=${spaceId}&q=stable-query&mode=vector&limit=1`);
    expect(a.vector.hits[0]?.chunk_id).toBe(b.vector.hits[0]?.chunk_id);
  });
});

describe("GET /search?mode=both", () => {
  it("populates both arrays in the same response", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    expect(data.mode).toBe("both");

    expect(data.keyword.hits.some((h: any) => h.label === "Alan Turing")).toBe(true);
    expect(data.vector.hits.length).toBeGreaterThan(0);

    // Each strategy carries its own ranking; the response doesn't fuse them.
    expect(typeof data.keyword.total).toBe("number");
    expect(typeof data.vector.total).toBe("number");
    expect(data.vector.model).toBe("mock@256");
  });

  it("limit applies independently per strategy", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=mathematician&limit=1`,
    );
    expect(data.keyword.hits.length).toBeLessThanOrEqual(1);
    expect(data.vector.hits.length).toBeLessThanOrEqual(1);
  });
});
