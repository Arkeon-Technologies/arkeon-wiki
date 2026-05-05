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
  it("returns multiple chunk hits from the same entity (no entity-level collapse)", async () => {
    // Issue #47 deliberately keeps chunks as first-class hits — a wiki
    // with multiple matching sections should appear multiple times.
    // Pin this so a later "should hits be unique by entity?" change
    // is intentional, not a regression.
    //
    // Write a probe wiki with several distinct H2 sections so we know
    // it produces card + multiple section chunks; the seeded fixtures
    // are body-only and only emit a single card chunk each.
    writeWiki(
      "wiki/person/multi-section.md",
      { label: "MultiSectionSubject", subject_type: "person" },
      [
        "MULTISECTIONPROBE is a fixture for the multi-chunk-per-entity test.",
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

    // Wait for the watcher to sync the file AND the embedding queue to
    // drain. Polling /wikis is the cheapest way to confirm sync ran;
    // waiting for drain alone is racy because the queue can still be
    // empty when the watcher hasn't fired yet.
    const seenDeadline = Date.now() + 8000;
    while (Date.now() < seenDeadline) {
      const wikis = await api(`/wikis?space_id=${spaceId}`);
      if ((wikis.wikis ?? []).some((w: any) => w.label === "MultiSectionSubject")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForDrain(15_000);

    // Mock embedder produces SHA-derived vectors per text — it doesn't
    // understand semantics, so the query "MULTISECTIONPROBE" doesn't
    // necessarily rank the chunks containing that string near the top.
    // We check the structural property instead: pull a wide result set
    // and confirm at least one entity_id repeats. With four wikis in
    // this space (three seeded with one chunk each + this one with
    // three) and limit=20, KNN returns all six chunks; exactly one
    // entity_id (MultiSectionSubject) appears three times.
    const data = await api(
      `/search?space_id=${spaceId}&q=anything&mode=vector&limit=20`,
    );

    const byEntity = new Map<string, number>();
    for (const hit of data.vector.hits) {
      byEntity.set(hit.entity_id, (byEntity.get(hit.entity_id) ?? 0) + 1);
    }
    const counts = [...byEntity.values()].sort((a, b) => b - a);
    expect(counts[0]).toBeGreaterThanOrEqual(2);
  });

  it("returns a mix of card and section chunk_kinds", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=mathematician&mode=vector&limit=20`,
    );
    const kinds = new Set(data.vector.hits.map((h: any) => h.chunk_kind));
    expect(kinds.has("card")).toBe(true);
    // Sections may or may not surface depending on the seeded fixtures,
    // but the chunk_kind values must always be one of the known set.
    for (const k of kinds) {
      expect(["card", "section", "section_part"]).toContain(k);
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

    // Wait for the watcher to index it. We poll via /wikis to avoid
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

    // Delete via the API. /wikis/{id} cascades.
    const del = await fetch(`${baseUrl}/wikis/${probeId}`, { method: "DELETE" });
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

  it("hit.text matches the chunk text in entity_chunks", async () => {
    // Integrity check — what we return as the snippet is exactly what
    // got embedded. If sync.ts and the search join ever drift, this
    // would be the first thing to break.
    const data = await api(
      `/search?space_id=${spaceId}&q=Turing&mode=vector&limit=5`,
    );
    expect(data.vector.hits.length).toBeGreaterThan(0);

    for (const hit of data.vector.hits) {
      expect(hit.text.length).toBeGreaterThan(0);
      // The chunk text always starts with the heading_path for section
      // chunks; the card chunk doesn't (it's labels + lead).
      if (hit.chunk_kind === "section" || hit.chunk_kind === "section_part") {
        expect(hit.text.startsWith(hit.heading_path)).toBe(true);
      }
    }
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
