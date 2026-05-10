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

// Port is assigned by the OS (port 0) and read back from the server's
// bound address. Hardcoding ports collides with anything the developer
// happens to be running locally.
let baseUrl: string;

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
  it("returns wiki-level hits with body, frontmatter, and similarity", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&mode=vector`);
    expect(data.vector).toBeDefined();
    expect(data.vector.model).toBe("mock@256");
    expect(data.vector.hits.length).toBeGreaterThan(0);

    for (const hit of data.vector.hits) {
      expect(typeof hit.entity_id).toBe("string");
      expect(typeof hit.label).toBe("string");
      expect(typeof hit.source_path).toBe("string");
      expect(typeof hit.body).toBe("string");
      expect(hit.body.length).toBeGreaterThan(0);
      expect(hit.frontmatter).toBeTypeOf("object");
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

  it("returns the same entity_id for repeated identical queries (mock determinism)", async () => {
    const a = await api(`/search?space_id=${spaceId}&q=stable-query&mode=vector&limit=1`);
    const b = await api(`/search?space_id=${spaceId}&q=stable-query&mode=vector&limit=1`);
    expect(a.vector.hits[0]?.entity_id).toBe(b.vector.hits[0]?.entity_id);
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

  it("contains the same entity independently in both arrays when both strategies match", async () => {
    // Mode=both runs the two strategies independently; nothing prevents
    // (and nothing helps) the same entity appearing in both. Pin the
    // semantic so a future "should we de-dup?" change is a deliberate
    // call, not an accident.
    const data = await api(`/search?space_id=${spaceId}&q=Turing`);
    const inKeyword = data.keyword.hits.some((h: any) => h.label === "Alan Turing");
    const inVector = data.vector.hits.some((h: any) => h.label === "Alan Turing");
    expect(inKeyword).toBe(true);

    if (inVector) {
      // No de-dup, no warning, no flag — both arrays hold the entity
      // independently of each other. This is deliberate.
      const kHit = data.keyword.hits.find((h: any) => h.label === "Alan Turing");
      const vHit = data.vector.hits.find((h: any) => h.label === "Alan Turing");
      expect(kHit.entity_id).toBe(vHit.entity_id);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Edge cases — added after the basic coverage to pin behavior we
// care about in production-shaped scenarios. Every one of these
// surfaced a real concern during design review.
// ────────────────────────────────────────────────────────────────────

describe("GET /search — vector edge cases", () => {
  it("collapses multiple chunk matches from the same wiki into a single hit", async () => {
    // Wiki-level result shape: a wiki with several matching sections
    // shows up exactly once, ranked by its best chunk's similarity.
    // Pin this so a later "should chunks be hits again?" change is an
    // intentional reversal, not a regression.
    //
    // Probe wiki with several H2 sections so it generates card +
    // multiple section chunks under the hood. The seeded fixtures are
    // body-only and only emit a single card chunk each.
    writeWiki(
      "wiki/person/multi-section.md",
      { label: "MultiSectionSubject", subject_type: "person" },
      [
        "MULTISECTIONPROBE is a fixture for the wiki-level dedup test.",
        "",
        "## First Section",
        "",
        "MULTISECTIONPROBE appears here in the first section.",
        "",
        "## Second Section",
        "",
        "MULTISECTIONPROBE also appears here in the second section.",
      ].join("\n"),
    );

    const seenDeadline = Date.now() + 8000;
    while (Date.now() < seenDeadline) {
      const wikis = await api(`/entities?type=wiki&space_id=${spaceId}`);
      if ((wikis.entities ?? []).some((w: any) => w.label === "MultiSectionSubject")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForDrain(15_000);

    const data = await api(
      `/search?space_id=${spaceId}&q=anything&mode=vector&limit=20`,
    );

    // Every entity_id should appear at most once. The mock embedder
    // ranking is deterministic-but-content-blind, but the dedup
    // property is structural and holds regardless of ranking.
    const byEntity = new Map<string, number>();
    for (const hit of data.vector.hits) {
      byEntity.set(hit.entity_id, (byEntity.get(hit.entity_id) ?? 0) + 1);
    }
    for (const count of byEntity.values()) {
      expect(count).toBe(1);
    }
  });

  it("excludes source (non-wiki) files from vector results", async () => {
    // Add a source file alongside the wikis. It enters `entities` as
    // type=file but never gets chunked, so vector search must not
    // surface it. Keyword search WILL find it by content match —
    // that's the right behaviour and worth comparing.
    writeFileSync(
      join(testDir, "notes.txt"),
      "Notes about a famous mathematician's letters.",
    );

    // Wait for the watcher to index it. We poll via /entities to avoid
    // racing with the embedding queue.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const k = await api(
        `/search?space_id=${spaceId}&q=letters&mode=keyword`,
      );
      if (k.keyword.hits.some((h: any) => h.source_path === "notes.txt")) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const both = await api(
      `/search?space_id=${spaceId}&q=letters&mode=both&limit=20`,
    );
    expect(both.keyword.hits.some((h: any) => h.source_path === "notes.txt")).toBe(true);
    for (const hit of both.vector.hits) {
      expect(hit.source_path).not.toBe("notes.txt");
    }
  });

  it("removes hits for deleted entities (cascade through chunk_vectors)", async () => {
    // Seed a probe wiki, confirm it shows up, delete it, confirm it
    // disappears. Exercises the cascade chain syncWikiFile → DELETE
    // entity_chunks → cascade entity_embeddings → manual chunk_vectors
    // cleanup that landed in PR #69.
    writeWiki(
      "wiki/concept/probe-delete.md",
      { label: "ProbeDeleteSubject", subject_type: "concept" },
      "ProbeDeleteSubject is a fixture for the deletion edge-case test.",
    );

    const seenDeadline = Date.now() + 8000;
    let probeId: string | null = null;
    while (Date.now() < seenDeadline) {
      const r = await api(
        `/search?space_id=${spaceId}&q=ProbeDeleteSubject&mode=vector`,
      );
      const hit = r.vector.hits.find(
        (h: any) => h.label === "ProbeDeleteSubject",
      );
      if (hit) {
        probeId = hit.entity_id;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(probeId).not.toBeNull();

    // Delete via the API. /entities/{id} cascades.
    const del = await fetch(`${baseUrl}/entities/${probeId}`, { method: "DELETE" });
    expect((await del.json() as { deleted: boolean }).deleted).toBe(true);

    // Vector results should no longer surface this entity. The chunk row
    // is gone (deleted by the route's removeByPath), the JOIN drops the
    // hit, and chunk_vectors was cleaned up at sync time.
    const after = await api(
      `/search?space_id=${spaceId}&q=ProbeDeleteSubject&mode=vector&limit=20`,
    );
    for (const hit of after.vector.hits) {
      expect(hit.entity_id).not.toBe(probeId);
    }
  });

  it("similarity stays in [-1, 1] for every hit", async () => {
    // Defensive — Ollama isn't guaranteed to return normalised vectors.
    // The mock embedder normalises, so this test should always hold here;
    // if a future embedder returns un-normalised values and this fails,
    // we'll know to clamp / normalise at the search boundary.
    const data = await api(
      `/search?space_id=${spaceId}&q=anything&mode=vector&limit=20`,
    );
    for (const hit of data.vector.hits) {
      expect(hit.similarity).toBeGreaterThanOrEqual(-1);
      expect(hit.similarity).toBeLessThanOrEqual(1);
    }
  });

  it("clamps limit > MAX_LIMIT to 200", async () => {
    // Pass a deliberately huge limit. The search function's Math.min
    // caps at MAX_LIMIT (200) so vec0's k= clause stays bounded. With
    // our small fixtures we won't return 200 hits, but the response
    // must succeed (no 400, no crash).
    const data = await api(
      `/search?space_id=${spaceId}&q=anything&mode=vector&limit=10000`,
    );
    expect(data.error).toBeUndefined();
    expect(data.vector.hits.length).toBeLessThanOrEqual(200);
  });

  it("reports the active embedder model on the response", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Turing&mode=vector`);
    expect(data.vector.model).toBe("mock@256");
    // When this assertion needs to change because someone wired Ollama
    // by default in tests, the failure is informative.
  });

  it("hit.body reflects the live file on disk", async () => {
    // The body comes from a fresh read at query time, not from cache —
    // an edit between sync and search lands in the response immediately.
    writeWiki(
      "wiki/concept/live-body-probe.md",
      { label: "LiveBodyProbe", subject_type: "concept" },
      "LiveBodyProbe is the original body.",
    );

    const seenDeadline = Date.now() + 8000;
    while (Date.now() < seenDeadline) {
      const r = await api(
        `/search?space_id=${spaceId}&q=LiveBodyProbe&mode=vector&limit=5`,
      );
      const hit = r.vector.hits.find((h: any) => h.label === "LiveBodyProbe");
      if (hit && hit.body.includes("original body")) {
        expect(hit.frontmatter.label).toBe("LiveBodyProbe");
        expect(hit.frontmatter.subject_type).toBe("concept");
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("LiveBodyProbe never appeared in vector search results");
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
      `/search?space_id=${spaceId}&q=%5CbTuring%5Cb&mode=keyword&regex=true`,
    );
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    expect(data.keyword.hits.some((h: any) => h.label === "Alan Turing")).toBe(true);
  });

  it("treats query as literal substring when regex is off", async () => {
    // Regex metacharacters in fixed-strings mode just don't match.
    // \bTuring\b as a literal substring won't appear anywhere.
    const data = await api(
      `/search?space_id=${spaceId}&q=%5CbTuring%5Cb&mode=keyword`,
    );
    expect(data.keyword.hits).toEqual([]);
  });
});

describe("GET /search — cross-space scoping", () => {
  // Register a SECOND space inside the same test file, write a wiki to
  // it, and confirm the space_id filter never leaks. This is the most
  // important correctness boundary — getting it wrong would silently
  // expose hits from spaces the caller didn't ask for.

  let secondSpaceId: string;
  let secondTestDir: string;

  beforeAll(async () => {
    secondTestDir = join(testDir, "..", "second-space-repo");
    mkdirSync(join(secondTestDir, "wiki", "person"), { recursive: true });

    // Use the same writeWiki helper but point it at the new dir by
    // overriding the global testDir for one call. Simpler: write the
    // file directly here so we don't have to plumb a second dir in.
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

    // Wait for chunks to embed in the new space.
    await waitForDrain(15_000);
  }, 30_000);

  it("vector search scoped to space A never returns hits from space B", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=SECOND_SPACE_PROBE_TOKEN&mode=vector&limit=20`,
    );
    for (const hit of data.vector.hits) {
      expect(hit.space_id).toBe(spaceId);
      expect(hit.label).not.toBe("Second Space Subject");
    }
  });

  it("vector search scoped to space B sees its own probe", async () => {
    const data = await api(
      `/search?space_id=${secondSpaceId}&q=SECOND_SPACE_PROBE_TOKEN&mode=vector&limit=20`,
    );
    for (const hit of data.vector.hits) {
      expect(hit.space_id).toBe(secondSpaceId);
    }
  });

  it("unscoped search sees hits from both spaces", async () => {
    const data = await api(`/search?q=SECOND_SPACE_PROBE_TOKEN&mode=vector&limit=20`);
    const spaceIds = new Set(data.vector.hits.map((h: any) => h.space_id));
    expect(spaceIds.has(secondSpaceId)).toBe(true);
  });

  it("keyword search scoped to one space never returns the other's files", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=SECOND_SPACE_PROBE_TOKEN&mode=keyword`,
    );
    expect(data.keyword.hits).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Issue #100: type filter + multi-query batching for keyword search.
// ────────────────────────────────────────────────────────────────────

describe("GET /search?mode=keyword — multi-query batching (#100)", () => {
  it("ORs multiple ?q= patterns in a single call", async () => {
    // Two patterns that match disjoint wikis. Without multi-query a
    // caller would have to issue two requests; with multi-query the
    // single response carries hits from both.
    const data = await api(
      `/search?space_id=${spaceId}&mode=keyword&q=Turing&q=Shannon`,
    );
    const labels = data.keyword.hits.map((h: any) => h.label);
    expect(labels).toContain("Alan Turing");
    expect(labels).toContain("Claude Shannon");
    // The route echoes the array form back so callers can confirm
    // they got the multi-pattern semantics.
    expect(data.query).toEqual(["Turing", "Shannon"]);
  });

  it("aggregates match counts across patterns so multi-pattern matches rank higher", async () => {
    // alan-turing.md mentions "Turing" twice and "mathematician" once.
    // claude-shannon.md mentions "mathematician" once but not "Turing".
    // Single-pattern ?q=mathematician → both wikis tie at 1.
    // Multi-pattern ?q=Turing&q=mathematician → turing.md sums to 3,
    // shannon.md stays at 1. Same in computability.md (mentions Turing).
    const data = await api(
      `/search?space_id=${spaceId}&mode=keyword&q=Turing&q=mathematician`,
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
    const data = await api(`/search?space_id=${spaceId}&mode=keyword&q=Turing`);
    expect(data.query).toBe("Turing");
  });

  it("rejects more than 10 patterns with 400", async () => {
    const params = Array.from({ length: 11 }, (_, i) => `q=p${i}`).join("&");
    const data = await api(
      `/search?space_id=${spaceId}&mode=keyword&${params}`,
    );
    expect(data.error?.code).toBe("validation_error");
  });

  it("vector response surfaces the embedded query via query_used", async () => {
    // Vector mode embeds only the first ?q=. Without explicit echo
    // a consumer sees `query: ["A","B","C"]` next to vector hits
    // derived purely from "A" — surprising. `vector.query_used`
    // makes the asymmetry explicit. Always present (even for
    // single-q calls) so consumers don't have to branch on shape.
    const multi = await api(
      `/search?space_id=${spaceId}&q=Turing&q=Shannon&mode=vector`,
    );
    expect(multi.vector.query_used).toBe("Turing");

    const single = await api(`/search?space_id=${spaceId}&q=Shannon&mode=vector`);
    expect(single.vector.query_used).toBe("Shannon");
  });
});

describe("GET /search?mode=keyword — type filter (#100)", () => {
  // Add a source file alongside the wikis so we have type=file rows
  // to filter on. The notes.txt added by the keyword edge-case suite
  // would also work but lives behind a different describe block —
  // duplicate the seed locally so test ordering doesn't bind us.
  beforeAll(async () => {
    writeFileSync(
      join(testDir, "source-doc.txt"),
      "source-doc covers ZZTYPEPROBE and other notes about Turing.",
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await api(
        `/search?space_id=${spaceId}&q=ZZTYPEPROBE&mode=keyword`,
      );
      if (r.keyword.hits.some((h: any) => h.source_path === "source-doc.txt")) {
        return;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error("source-doc.txt never appeared in keyword search");
  }, 15_000);

  it("type=file restricts hits to source files (no wikis)", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=keyword&type=file`,
    );
    expect(data.keyword.hits.length).toBeGreaterThan(0);
    for (const hit of data.keyword.hits) {
      expect(hit.type).toBe("file");
    }
    expect(
      data.keyword.hits.some((h: any) => h.source_path === "source-doc.txt"),
    ).toBe(true);
    // Wikis under wiki/ must not appear when type=file.
    expect(
      data.keyword.hits.some((h: any) => h.source_path.startsWith("wiki/")),
    ).toBe(false);
  });

  it("type=wiki restricts hits to wikis (no source files)", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=keyword&type=wiki`,
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
      `/search?space_id=${spaceId}&q=Turing&mode=keyword&type=wiki,file`,
    );
    const types = new Set(data.keyword.hits.map((h: any) => h.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
  });

  it("omitted type returns hits of every type", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=keyword`,
    );
    const types = new Set(data.keyword.hits.map((h: any) => h.type));
    // Both wiki and file rows match the query when no filter is set.
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
  });

  it("rejects an invalid type with 400", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=keyword&type=bogus`,
    );
    expect(data.error?.code).toBe("validation_error");
  });

  it("type filter does not inflate unmatched_files diagnostic", async () => {
    // Files filtered out by `type` are explicitly excluded — they're
    // not the "ripgrep matched but no entity row" condition the
    // unmatched_files counter is for. Verify by comparing a no-filter
    // call (where wiki/file paths both have entities, so unmatched=0)
    // to a type=file call (which drops wiki rows in JS, not as
    // unmatched). Both calls should report the same unmatched count.
    const all = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=keyword`,
    );
    const filtered = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=keyword&type=file`,
    );
    expect(filtered.keyword.unmatched_files).toBe(all.keyword.unmatched_files);
  });
});
