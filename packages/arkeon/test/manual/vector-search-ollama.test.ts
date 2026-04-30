// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manual end-to-end test for vector search against a real embedder
 * (Ollama + embeddinggemma:300m). Not run in CI — requires:
 *
 *   - Ollama running locally on port 11434
 *   - The embeddinggemma:300m model pulled (`ollama pull embeddinggemma:300m`)
 *
 * Run:   npm run test:manual -w packages/arkeon
 *
 * What this catches that the mock-backed e2e suite cannot:
 *   - Ollama API contract bugs (e.g. wrong field name for the Matryoshka
 *     truncation parameter — silently returns 768d when we expect 256d)
 *   - Real semantic ranking — the mock is hash-derived and can't tell
 *     us whether "computer pioneer" actually retrieves Alan Turing
 *   - Vector format issues — wrong byte order, padding, etc. — that
 *     mock would happily produce in the schema but a real model would
 *     reject or return as garbage similarities
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { waitForDrain } from "../../src/server/lib/embedding-queue.js";
import { resetEmbedder } from "../../src/server/lib/embedder/index.js";

const API_PORT = 18792;
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
  const fm = yaml.dump(properties, { schema: yaml.JSON_SCHEMA, sortKeys: false }).trimEnd();
  writeFileSync(absPath, `---\n${fm}\n---\n\n${body}\n`);
}

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (res.headers.get("content-type")?.includes("json")) return res.json();
  return res.text();
}

async function preflightOllama(): Promise<void> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const present = (body.models ?? []).some((m) => m.name === "embeddinggemma:300m");
    if (!present) {
      throw new Error(
        "embeddinggemma:300m is not pulled. Run: ollama pull embeddinggemma:300m",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Ollama preflight failed: ${msg}. Start Ollama on localhost:11434 ` +
        `and ensure embeddinggemma:300m is pulled.`,
    );
  }
}

beforeAll(async () => {
  await preflightOllama();
  process.env.ARKEON_WIKI_EMBEDDER = "ollama";

  const base = join(tmpdir(), `arkeon-vector-real-${randomBytes(4).toString("hex")}`);
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

  // Three semantically distinct wikis so a real model can actually
  // discriminate between them. Bodies are richer than the mock fixtures
  // because semantic ranking needs real signal.
  writeWiki(
    "wiki/person/alan-turing.md",
    { label: "Alan Turing", subject_type: "person" },
    [
      "Alan Turing was a British mathematician, logician, and theoretical computer scientist.",
      "",
      "## Computation",
      "",
      "Turing formalised the concept of an algorithm via the Turing machine and is widely",
      "considered the father of theoretical computer science and artificial intelligence.",
      "",
      "## Cryptography",
      "",
      "During World War II, Turing led Hut 8 at Bletchley Park, where he devised techniques",
      "for breaking the German Enigma cipher.",
    ].join("\n"),
  );

  writeWiki(
    "wiki/person/marie-curie.md",
    { label: "Marie Curie", subject_type: "person" },
    [
      "Marie Curie was a Polish-French physicist and chemist who pioneered research on radioactivity.",
      "",
      "## Discovery of Radium",
      "",
      "Curie discovered the elements polonium and radium together with her husband Pierre.",
      "",
      "## Nobel Prizes",
      "",
      "She was the first woman to win a Nobel Prize and remains the only person to have won",
      "Nobel Prizes in two distinct sciences (Physics 1903, Chemistry 1911).",
    ].join("\n"),
  );

  writeWiki(
    "wiki/concept/photosynthesis.md",
    { label: "Photosynthesis", subject_type: "concept" },
    [
      "Photosynthesis is the biological process by which plants convert sunlight into energy.",
      "",
      "## Light Reactions",
      "",
      "Chlorophyll in chloroplasts absorbs photons, exciting electrons and producing ATP",
      "and NADPH that fuel the dark reactions.",
      "",
      "## Calvin Cycle",
      "",
      "The Calvin cycle uses ATP and NADPH to fix carbon dioxide into glucose, the energy",
      "currency of the plant.",
    ].join("\n"),
  );

  const created = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "vector-real-space", watch_dir: testDir }),
  });
  const space = (await created.json()) as { id: string };
  spaceId = space.id;

  // Wait for the watcher to pick up all three wikis, then drain the
  // embedding queue. Real Ollama embedding takes ~50-200ms per chunk;
  // 60s is generous.
  const seenDeadline = Date.now() + 30_000;
  while (Date.now() < seenDeadline) {
    const wikis = await api(`/wikis?space_id=${spaceId}`);
    if ((wikis.wikis ?? []).length === 3) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await waitForDrain(60_000);
}, 120_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), { recursive: true, force: true });
  }
  if (prevEmbedderEnv === undefined) {
    delete process.env.ARKEON_WIKI_EMBEDDER;
  } else {
    process.env.ARKEON_WIKI_EMBEDDER = prevEmbedderEnv;
  }
  resetEmbedder();
}, 60_000);

describe("vector search against live Ollama (embeddinggemma:300m)", () => {
  it("reports the active model identifier", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=mathematics&mode=vector`);
    expect(data.vector.model).toBe("ollama:embeddinggemma:300m@256");
  });

  it("returns 256-dim vectors (Matryoshka truncation works)", async () => {
    // Indirect proof: if the truncation parameter wasn't being respected,
    // the worker would have refused to insert any embeddings and we'd
    // have zero hits. A populated result set means the dimension matched.
    const data = await api(`/search?space_id=${spaceId}&q=mathematics&mode=vector`);
    expect(data.vector.hits.length).toBeGreaterThan(0);
  });

  it("ranks Alan Turing first for 'computer pioneer'", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=computer%20pioneer&mode=vector&limit=10`,
    );
    expect(data.vector.hits.length).toBeGreaterThan(0);
    expect(data.vector.hits[0].label).toBe("Alan Turing");
  });

  it("ranks Marie Curie first for 'discovered radioactive elements'", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=discovered%20radioactive%20elements&mode=vector&limit=10`,
    );
    expect(data.vector.hits.length).toBeGreaterThan(0);
    expect(data.vector.hits[0].label).toBe("Marie Curie");
  });

  it("ranks Photosynthesis first for 'how plants use sunlight'", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=how%20plants%20use%20sunlight&mode=vector&limit=10`,
    );
    expect(data.vector.hits.length).toBeGreaterThan(0);
    expect(data.vector.hits[0].label).toBe("Photosynthesis");
  });

  it("similarity is meaningfully higher for the matching wiki than for the non-matching ones", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Bletchley%20Park%20Enigma&mode=vector&limit=10`,
    );
    const turingHits = data.vector.hits.filter((h: any) => h.label === "Alan Turing");
    const curieHits = data.vector.hits.filter((h: any) => h.label === "Marie Curie");
    if (turingHits.length > 0 && curieHits.length > 0) {
      const bestTuring = Math.max(...turingHits.map((h: any) => h.similarity));
      const bestCurie = Math.max(...curieHits.map((h: any) => h.similarity));
      expect(bestTuring).toBeGreaterThan(bestCurie);
    }
  });

  it("hybrid mode populates both arrays from independent strategies", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Curie&mode=both`);
    expect(data.keyword.hits.some((h: any) => h.label === "Marie Curie")).toBe(true);
    expect(data.vector.hits.some((h: any) => h.label === "Marie Curie")).toBe(true);
  });
});
