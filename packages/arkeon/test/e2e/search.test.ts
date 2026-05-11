// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for the /search endpoint.
 *
 * Spins up a SQLite DB + API server in-process, registers a temp
 * directory as a space, writes a few wiki files, and asserts that
 * GET /search returns keyword hits via ripgrep.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

// Port is assigned by the OS (port 0) and read back from the server's
// bound address. Hardcoding ports collides with anything the developer
// happens to be running locally.
let baseUrl: string;

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
  const res = await fetch(`${baseUrl}${path}`);
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
    const data = await api(`/entities?type=wiki&space_id=${spaceId}`);
    if ((data.entities ?? []).length === expected) return data.entities;
    await new Promise((r) => setTimeout(r, 200));
  }
  const data = await api(`/entities?type=wiki&space_id=${spaceId}`);
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
  const apiHandle = await startApi({ port: 0, dbPath: dbFile });
  baseUrl = `http://localhost:${apiHandle.address.port}`;
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

  const created = await fetch(`${baseUrl}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "search-space", watch_dir: testDir }),
  });
  const space = (await created.json()) as { id: string };
  spaceId = space.id;

  await waitForWikiCount(3, spaceId);
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

describe("GET /search — validation + envelope", () => {
  it("returns 400 when q is missing", async () => {
    const data = await api(`/search?space_id=${spaceId}`);
    expect(data.error?.code).toBe("validation_error");
  });

  it("namespaces results under keyword", async () => {
    const k = await api(`/search?space_id=${spaceId}&q=Turing`);
    expect(k.keyword).toBeDefined();
    expect(k.vector).toBeUndefined();
  });
});

describe("GET /search — keyword", () => {
  it("finds wikis matching a literal query", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    expect(data.query).toBe("Turing");
    expect(data.keyword.hits.length).toBeGreaterThanOrEqual(2);

    const labels = data.keyword.hits.map((h: any) => h.label);
    expect(labels).toContain("Alan Turing");
    expect(labels).toContain("Computability");
  });

  it("ranks hits by match count", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    const turing = data.keyword.hits.find((h: any) => h.label === "Alan Turing");
    const computability = data.keyword.hits.find((h: any) => h.label === "Computability");
    expect(turing.match_count).toBeGreaterThan(computability.match_count);
    expect(data.keyword.hits[0].label).toBe("Alan Turing");
  });

  it("returns snippets with line numbers", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=mathematician`);
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
    const data = await api(`/search?space_id=${spaceId}&q=mathematician&limit=1`);
    expect(data.keyword.hits).toHaveLength(1);
  });

  it("respects the snippets parameter", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&snippets=1`);
    for (const hit of data.keyword.hits) {
      expect(hit.snippets.length).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty hits for queries with no matches", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=zzznotpresentzzz`);
    expect(data.keyword.hits).toEqual([]);
  });

  it("searches all spaces when space_id is omitted", async () => {
    const data = await api(`/search?q=Shannon`);
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    expect(data.keyword.hits.some((h: any) => h.label === "Claude Shannon")).toBe(true);
  });

  it("searches case-insensitively when query is lowercase (smart-case)", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=turing`);
    expect(data.keyword.hits.some((h: any) => h.label === "Alan Turing")).toBe(true);
  });
});

describe("GET /search — keyword edge cases", () => {
  it("supports regex mode", async () => {
    // The regex flag toggles ripgrep's --fixed-strings off. A regex
    // query that wouldn't match as a literal substring should still
    // match. We use \\bTuring\\b — the literal `\bTuring\b` doesn't
    // appear in any wiki, but as a regex it matches "Turing" word
    // boundaries.
    const data = await api(
      `/search?space_id=${spaceId}&q=%5CbTuring%5Cb&regex=true`,
    );
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    expect(data.keyword.hits.some((h: any) => h.label === "Alan Turing")).toBe(true);
  });

  it("treats query as literal substring when regex is off", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=%5CbTuring%5Cb`);
    expect(data.keyword.hits).toEqual([]);
  });
});

describe("GET /search — cross-space scoping", () => {
  let secondSpaceId: string;
  let secondTestDir: string;

  beforeAll(async () => {
    secondTestDir = join(testDir, "..", "second-space-repo");
    mkdirSync(join(secondTestDir, "wiki", "person"), { recursive: true });

    const fm = yaml.dump(
      { label: "Second Space Subject", subject_type: "person" },
      { schema: yaml.JSON_SCHEMA, sortKeys: false },
    ).trimEnd();
    writeFileSync(
      join(secondTestDir, "wiki", "person", "subject.md"),
      `---\n${fm}\n---\n\nA scoped probe: SECOND_SPACE_PROBE_TOKEN appears here.`,
    );

    const created = await fetch(`${baseUrl}/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "second-search-space",
        watch_dir: secondTestDir,
      }),
    });
    secondSpaceId = ((await created.json()) as { id: string }).id;
  }, 30_000);

  it("keyword search scoped to one space never returns the other's files", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=SECOND_SPACE_PROBE_TOKEN`,
    );
    expect(data.keyword.hits).toEqual([]);
  });

  it("keyword search scoped to space B sees its own probe", async () => {
    // Allow watcher a moment to pick up the new space.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await api(
        `/search?space_id=${secondSpaceId}&q=SECOND_SPACE_PROBE_TOKEN`,
      );
      if (r.keyword.hits.length > 0) {
        for (const hit of r.keyword.hits) {
          expect(hit.space_id).toBe(secondSpaceId);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Second space probe never indexed");
  });
});

describe("GET /search — multi-query batching (#100)", () => {
  it("ORs multiple ?q= patterns in a single call", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&q=Shannon`,
    );
    const labels = data.keyword.hits.map((h: any) => h.label);
    expect(labels).toContain("Alan Turing");
    expect(labels).toContain("Claude Shannon");
    expect(data.query).toEqual(["Turing", "Shannon"]);
  });

  it("aggregates match counts across patterns so multi-pattern matches rank higher", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&q=mathematician`,
    );
    const turing = data.keyword.hits.find((h: any) => h.label === "Alan Turing");
    const shannon = data.keyword.hits.find(
      (h: any) => h.label === "Claude Shannon",
    );
    expect(turing).toBeDefined();
    expect(shannon).toBeDefined();
    expect(turing.match_count).toBeGreaterThan(shannon.match_count);
    expect(data.keyword.hits[0].label).toBe("Alan Turing");
  });

  it("preserves single-string echo when only one ?q= is passed", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    expect(data.query).toBe("Turing");
  });

  it("rejects more than 10 patterns with 400", async () => {
    const params = Array.from({ length: 11 }, (_, i) => `q=p${i}`).join("&");
    const data = await api(`/search?space_id=${spaceId}&${params}`);
    expect(data.error?.code).toBe("validation_error");
  });
});

describe("GET /search — type filter (#100)", () => {
  beforeAll(async () => {
    writeFileSync(
      join(testDir, "source-doc.txt"),
      "source-doc covers ZZTYPEPROBE and other notes about Turing.",
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await api(`/search?space_id=${spaceId}&q=ZZTYPEPROBE`);
      if (r.keyword.hits.some((h: any) => h.source_path === "source-doc.txt")) {
        return;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error("source-doc.txt never appeared in keyword search");
  }, 15_000);

  it("type=file restricts hits to source files (no wikis)", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&type=file`,
    );
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    for (const hit of data.keyword.hits) {
      expect(hit.type).toBe("file");
    }
    expect(
      data.keyword.hits.some((h: any) => h.source_path === "source-doc.txt"),
    ).toBe(true);
    expect(
      data.keyword.hits.some((h: any) => h.source_path.startsWith("wiki/")),
    ).toBe(false);
  });

  it("type=wiki restricts hits to wikis (no source files)", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&type=wiki`,
    );
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    for (const hit of data.keyword.hits) {
      expect(hit.type).toBe("wiki");
    }
    expect(
      data.keyword.hits.some((h: any) => h.source_path === "source-doc.txt"),
    ).toBe(false);
  });

  it("type=wiki,file accepts both", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&type=wiki,file`,
    );
    const types = new Set(data.keyword.hits.map((h: any) => h.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
  });

  it("omitted type returns hits of every type", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    const types = new Set(data.keyword.hits.map((h: any) => h.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
  });

  it("rejects an invalid type with 400", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&type=bogus`,
    );
    expect(data.error?.code).toBe("validation_error");
  });

  it("rejects type=stub with the #104 migration message", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&type=stub`,
    );
    expect(data.error?.code).toBe("validation_error");
    expect(data.error?.message).toMatch(/unresolved/i);
  });

  it("type filter does not inflate unmatched_files diagnostic", async () => {
    const all = await api(`/search?space_id=${spaceId}&q=Turing`);
    const filtered = await api(
      `/search?space_id=${spaceId}&q=Turing&type=file`,
    );
    expect(filtered.keyword.unmatched_files).toBe(all.keyword.unmatched_files);
  });
});
