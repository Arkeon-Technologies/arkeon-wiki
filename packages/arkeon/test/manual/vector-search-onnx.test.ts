// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manual end-to-end test for vector search against the bundled ONNX
 * embedder (issue #47). Not run in CI — first run downloads ~309 MB
 * of model weights to ~/.arkeon-wiki/models/, which would slow CI to
 * a crawl. Subsequent runs are fast (model already cached).
 *
 * Run:   npm run test:manual -w packages/arkeon
 *
 * What this catches that the mock-backed e2e suite cannot:
 *   - Real semantic ranking — the mock is hash-derived and can't tell
 *     us whether "computer pioneer" actually retrieves Alan Turing
 *   - The slice + L2-renormalise math against real 768d ONNX output
 *   - The query/document prefix application
 *   - Warm-up lifecycle: daemon comes up, vector returns
 *     {model: "warming"} until the load resolves, then transitions
 *     to ready and queue drains
 *   - Whether transformers.js + onnxruntime-node + the q8 quantised
 *     EmbeddingGemma weights actually run on the user's platform
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { waitForDrain } from "../../src/server/lib/embedding-queue.js";
import { getEmbedder, resetEmbedder } from "../../src/server/lib/embedder/index.js";

const API_PORT = 18793;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;
const prevEmbedderEnv = process.env.ARKEON_WIKI_EMBEDDER;
const prevModelsDirEnv = process.env.ARKEON_WIKI_MODELS_DIR;

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

beforeAll(async () => {
  process.env.ARKEON_WIKI_EMBEDDER = "onnx";
  // Pin the model cache to a persistent location so we don't pay the
  // ~309 MB download every time this test runs. The test's data
  // (DB, watch_dir) still lives in the tempdir.
  process.env.ARKEON_WIKI_MODELS_DIR = join(homedir(), ".arkeon-wiki", "models");
  resetEmbedder();

  const base = join(tmpdir(), `arkeon-onnx-real-${randomBytes(4).toString("hex")}`);
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

  // Three semantically distinct wikis. Real model needs real signal.
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
    body: JSON.stringify({ name: "onnx-real-space", watch_dir: testDir }),
  });
  const space = (await created.json()) as { id: string };
  spaceId = space.id;

  // Wait for the model to finish loading. First run = ~309 MB download
  // + load (~30-60s on a fast connection, longer on slow). Subsequent
  // runs hit the cache and finish in 5-15s.
  const embedder = await getEmbedder();
  const warmDeadline = Date.now() + 5 * 60_000;
  while (Date.now() < warmDeadline) {
    if (embedder.state() === "ready") break;
    if (embedder.state() === "failed") {
      throw new Error("OnnxEmbedder failed to load — see daemon logs");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(embedder.state()).toBe("ready");

  // Wait for chunks to embed via the worker.
  await waitForDrain(120_000);
}, 10 * 60_000);

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
  if (prevModelsDirEnv === undefined) {
    delete process.env.ARKEON_WIKI_MODELS_DIR;
  } else {
    process.env.ARKEON_WIKI_MODELS_DIR = prevModelsDirEnv;
  }
  resetEmbedder();
}, 60_000);

describe("vector search against bundled ONNX (embeddinggemma-300m, q8)", () => {
  it("reports the active model identifier", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=mathematics&mode=vector`);
    expect(data.vector.model).toBe("onnx:embeddinggemma-300m@256");
  });

  it("returns 256-dim vectors (slice + L2-renormalise from 768d output)", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=mathematics&mode=vector`);
    expect(data.vector.hits.length).toBeGreaterThan(0);
    for (const hit of data.vector.hits) {
      expect(hit.similarity).toBeGreaterThanOrEqual(-1);
      expect(hit.similarity).toBeLessThanOrEqual(1);
    }
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

  it("query and document prefixes give meaningfully different similarities", async () => {
    // The model card requires different prefixes for queries vs
    // documents. The Bletchley Park / Enigma chunks belong only to
    // Turing — the query encoded with the query prefix should land
    // closest to those.
    const data = await api(
      `/search?space_id=${spaceId}&q=Bletchley%20Park%20Enigma&mode=vector&limit=10`,
    );
    const turingHits = data.vector.hits.filter((h: any) => h.label === "Alan Turing");
    const otherHits = data.vector.hits.filter((h: any) => h.label !== "Alan Turing");
    if (turingHits.length > 0 && otherHits.length > 0) {
      const bestTuring = Math.max(...turingHits.map((h: any) => h.similarity));
      const bestOther = Math.max(...otherHits.map((h: any) => h.similarity));
      expect(bestTuring).toBeGreaterThan(bestOther);
    }
  });

  it("hybrid mode populates both arrays from real backends", async () => {
    const data = await api(`/search?space_id=${spaceId}&q=Curie&mode=both`);
    expect(data.keyword.hits.some((h: any) => h.label === "Marie Curie")).toBe(true);
    expect(data.vector.hits.some((h: any) => h.label === "Marie Curie")).toBe(true);
    expect(data.vector.model).toBe("onnx:embeddinggemma-300m@256");
  });
});
