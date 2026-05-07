// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Full product journey, real ONNX (issue #47).
 *
 * Loads a 15-wiki Information Theory corpus with realistic multi-
 * section content and cross-references, waits for the chunker +
 * embedder pipeline to drain, then exercises a battery of semantic
 * queries against the real EmbeddingGemma model. Each query has a
 * known expected top-1 wiki — wrong answers indicate retrieval
 * regression.
 *
 * Not run in CI. Requires:
 *   - Network access to HuggingFace Hub on first run (model
 *     download, ~309 MB to ~/.arkeon-wiki/models/)
 *   - ~3-5 minutes on first run (download + 15 wikis × multiple
 *     chunks each through real ONNX)
 *   - Subsequent runs are faster (cache hit, ~30-60s)
 *
 * Run:   npm run test:manual -w packages/arkeon
 *
 * What this catches that nothing else does:
 *   - Retrieval-quality regressions (mock-backed tests can't tell
 *     us whether the model is actually finding the right wiki)
 *   - Real-world chunk shape: multi-section wikis, cross-references,
 *     code blocks, tables — content the synthetic fixtures don't
 *     have
 *   - Cumulative pipeline behavior: 15 wikis × ~5 chunks each = 75+
 *     embeddings, exercises the worker drain at non-trivial scale
 *   - Within-corpus discrimination: queries that could match
 *     several wikis must rank the *most relevant* first
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { waitForDrain, queueStats } from "../../src/server/lib/embedding-queue.js";
import { getEmbedder, resetEmbedder } from "../../src/server/lib/embedder/index.js";

const API_PORT = 18794;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;
const prevEmbedderEnv = process.env.ARKEON_WIKI_EMBEDDER;
const prevModelsDirEnv = process.env.ARKEON_WIKI_MODELS_DIR;

interface VectorHit {
  entity_id: string;
  space_id: string;
  label: string;
  source_path: string;
  similarity: number;
  frontmatter: Record<string, unknown>;
  body: string;
}

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

async function vectorSearch(query: string, limit = 10): Promise<VectorHit[]> {
  const data = await api(
    `/search?space_id=${spaceId}&q=${encodeURIComponent(query)}&mode=vector&limit=${limit}`,
  );
  return data.vector?.hits ?? [];
}

// ─── The corpus ─────────────────────────────────────────────────────
// 15 wikis on a coherent theme (Information Theory). Each has multiple
// H2 sections with real content. Cross-references via standard
// markdown links. Subjects span people, concepts, places.

const CORPUS: Array<{ path: string; props: Record<string, unknown>; body: string }> = [
  {
    path: "wiki/person/claude-shannon.md",
    props: {
      label: "Claude Shannon",
      subject_type: "person",
      short_description: "American mathematician, father of information theory.",
    },
    body: [
      "Claude Elwood Shannon (1916–2001) was an American mathematician, electrical engineer, and cryptographer. He is widely regarded as the father of information theory.",
      "",
      "## Mathematical Theory of Communication",
      "",
      "In 1948, Shannon published *A Mathematical Theory of Communication* in the Bell System Technical Journal. The paper laid the foundation for [Information Theory](../concept/information-theory.md), introducing the concept of [Entropy](../concept/entropy.md) as a measure of uncertainty and the [Bit](../concept/bit.md) as the fundamental unit of information.",
      "",
      "## Career at Bell Labs",
      "",
      "Shannon joined [Bell Labs](../organization/bell-labs.md) in 1941 and remained there for fifteen years. His work on switching circuits, cryptography, and information theory transformed the field of digital communication. He later became a professor at [MIT](../organization/mit.md).",
      "",
      "## Boolean Algebra Connection",
      "",
      "Shannon's 1937 master's thesis at MIT showed that [Boolean Algebra](../concept/boolean-algebra.md) could be applied to electromechanical relay circuits, laying the groundwork for digital circuit design.",
    ].join("\n"),
  },
  {
    path: "wiki/person/alan-turing.md",
    props: {
      label: "Alan Turing",
      subject_type: "person",
      short_description: "British mathematician and theoretical computer scientist.",
    },
    body: [
      "Alan Mathison Turing (1912–1954) was a British mathematician, logician, and theoretical computer scientist. He is considered the father of theoretical computer science and artificial intelligence.",
      "",
      "## Theory of Computation",
      "",
      "Turing formalized the concept of an [Algorithm](../concept/algorithm.md) and the abstract notion of computation through his [Turing Machine](../concept/turing-machine.md), introduced in his 1936 paper on computable numbers.",
      "",
      "## Wartime Cryptography",
      "",
      "During World War II, Turing led Hut 8 at [Bletchley Park](../organization/bletchley-park.md), where he devised techniques for breaking the German Enigma cipher. His work shortened the war by an estimated two years.",
      "",
      "## Artificial Intelligence",
      "",
      "Turing proposed what is now called the Turing Test in his 1950 paper *Computing Machinery and Intelligence*, asking whether machines can think.",
    ].join("\n"),
  },
  {
    path: "wiki/person/john-von-neumann.md",
    props: {
      label: "John von Neumann",
      subject_type: "person",
      short_description: "Hungarian-American mathematician and polymath.",
    },
    body: [
      "John von Neumann (1903–1957) was a Hungarian-American mathematician, physicist, computer scientist, engineer, and polymath. He made foundational contributions to mathematics, quantum mechanics, economics, and computing.",
      "",
      "## Computer Architecture",
      "",
      "Von Neumann developed the von Neumann architecture, the design of stored-program computers in which both data and instructions reside in the same memory. This remains the dominant architecture in modern computing.",
      "",
      "## Game Theory",
      "",
      "His 1944 book *Theory of Games and Economic Behavior*, co-authored with Oskar Morgenstern, founded modern game theory.",
      "",
      "## Cellular Automata",
      "",
      "Von Neumann pioneered the study of self-replicating cellular automata, anticipating later work in artificial life and complex systems.",
    ].join("\n"),
  },
  {
    path: "wiki/person/norbert-wiener.md",
    props: {
      label: "Norbert Wiener",
      subject_type: "person",
      short_description: "American mathematician, founder of cybernetics.",
    },
    body: [
      "Norbert Wiener (1894–1964) was an American mathematician and philosopher. He is best known as the founder of [Cybernetics](../concept/cybernetics.md), a discipline that formalizes the study of control and communication in animals, machines, and organizations.",
      "",
      "## Cybernetics",
      "",
      "Wiener's 1948 book *Cybernetics: Or Control and Communication in the Animal and the Machine* established the field. He drew on feedback theory, [Information Theory](../concept/information-theory.md), and his wartime work on anti-aircraft fire control.",
      "",
      "## MIT and Stochastic Processes",
      "",
      "Wiener spent most of his career at [MIT](../organization/mit.md), where he made foundational contributions to stochastic processes — the Wiener process is named for him.",
    ].join("\n"),
  },
  {
    path: "wiki/person/andrey-kolmogorov.md",
    props: {
      label: "Andrey Kolmogorov",
      subject_type: "person",
      short_description: "Soviet mathematician, founder of modern probability theory.",
    },
    body: [
      "Andrey Nikolaevich Kolmogorov (1903–1987) was a Soviet mathematician who made fundamental contributions to probability theory, topology, intuitionistic logic, turbulence, classical mechanics, algorithmic [Information Theory](../concept/information-theory.md), and computational complexity.",
      "",
      "## Axiomatic Probability",
      "",
      "His 1933 monograph *Foundations of the Theory of Probability* gave probability its modern axiomatic basis.",
      "",
      "## Algorithmic Complexity",
      "",
      "Kolmogorov complexity measures the length of the shortest computer program that produces a given object. It connects [Information Theory](../concept/information-theory.md) with the theory of [Algorithms](../concept/algorithm.md).",
    ].join("\n"),
  },
  {
    path: "wiki/concept/information-theory.md",
    props: {
      label: "Information Theory",
      subject_type: "concept",
      short_description: "Mathematical study of the quantification, storage, and communication of information.",
    },
    body: [
      "Information theory is the mathematical study of the quantification, storage, and communication of information. It was founded by [Claude Shannon](../person/claude-shannon.md) in his 1948 paper *A Mathematical Theory of Communication*.",
      "",
      "## Core Quantities",
      "",
      "The central measures are [Entropy](./entropy.md), conditional entropy, mutual information, and channel capacity. The unit of information is the [Bit](./bit.md).",
      "",
      "## Source and Channel Coding",
      "",
      "Shannon's source coding theorem establishes the limits of lossless data compression. His noisy channel coding theorem establishes the maximum reliable communication rate over a noisy channel.",
      "",
      "## Connections",
      "",
      "Information theory is closely related to [Cybernetics](./cybernetics.md), statistical mechanics, and probability theory.",
    ].join("\n"),
  },
  {
    path: "wiki/concept/entropy.md",
    props: {
      label: "Entropy",
      subject_type: "concept",
      short_description: "Measure of uncertainty in a probability distribution.",
    },
    body: [
      "In [Information Theory](./information-theory.md), entropy quantifies the average level of uncertainty inherent in a random variable's possible outcomes. It is measured in [Bits](./bit.md).",
      "",
      "## Definition",
      "",
      "For a discrete random variable X with probability mass function p, the Shannon entropy is H(X) = −Σ p(x) log₂ p(x). Entropy is maximized when outcomes are equally likely.",
      "",
      "## Interpretations",
      "",
      "Entropy can be interpreted as the average number of bits needed to encode an outcome, or as a measure of unpredictability.",
      "",
      "## Connection to Thermodynamics",
      "",
      "Shannon entropy is mathematically analogous to thermodynamic entropy, a connection [Claude Shannon](../person/claude-shannon.md) discussed with John von Neumann.",
    ].join("\n"),
  },
  {
    path: "wiki/concept/cybernetics.md",
    props: {
      label: "Cybernetics",
      subject_type: "concept",
      short_description: "Mathematical study of control and communication in animals, machines, and organizations.",
    },
    body: [
      "Cybernetics is the transdisciplinary study of regulatory and purposive systems — their structures, constraints, and possibilities. It was founded by [Norbert Wiener](../person/norbert-wiener.md) in 1948.",
      "",
      "## Feedback and Control",
      "",
      "Central to cybernetics is the concept of negative feedback: a system observes its own output and adjusts its behaviour to maintain a desired state. Examples range from thermostats to biological homeostasis.",
      "",
      "## Relationship to Information Theory",
      "",
      "Cybernetics overlaps with [Information Theory](./information-theory.md) and systems theory; both formalize how information flows through and shapes a system's behaviour.",
    ].join("\n"),
  },
  {
    path: "wiki/concept/turing-machine.md",
    props: {
      label: "Turing Machine",
      subject_type: "concept",
      short_description: "Abstract mathematical model of computation.",
    },
    body: [
      "A Turing machine is an abstract mathematical model of computation, introduced by [Alan Turing](../person/alan-turing.md) in 1936. It consists of an infinite tape, a head that reads and writes symbols, and a finite state controller.",
      "",
      "## Computability",
      "",
      "The Church–Turing thesis posits that any function computable by an [Algorithm](./algorithm.md) is computable by some Turing machine. This makes the Turing machine the canonical model of what it means for something to be computable.",
      "",
      "## Variants",
      "",
      "Variants include multi-tape machines, non-deterministic Turing machines, and probabilistic Turing machines. All are computationally equivalent in terms of what they can compute, though they differ in efficiency.",
    ].join("\n"),
  },
  {
    path: "wiki/concept/boolean-algebra.md",
    props: {
      label: "Boolean Algebra",
      subject_type: "concept",
      short_description: "Algebra of truth values and logical operations.",
    },
    body: [
      "Boolean algebra is a branch of algebra in which the values of variables are the truth values true and false, usually denoted 1 and 0. The operations are conjunction (AND), disjunction (OR), and negation (NOT).",
      "",
      "## Origins",
      "",
      "Boolean algebra was introduced by George Boole in his 1854 book *An Investigation of the Laws of Thought*.",
      "",
      "## Application to Circuits",
      "",
      "[Claude Shannon](../person/claude-shannon.md) showed in 1937 that Boolean algebra could describe the behaviour of switching circuits, founding modern digital logic design.",
    ].join("\n"),
  },
  {
    path: "wiki/concept/bit.md",
    props: {
      label: "Bit",
      subject_type: "concept",
      short_description: "Basic unit of information; binary digit with two possible values.",
    },
    body: [
      "A bit (short for binary digit) is the basic unit of information in computing and digital communications. A bit can hold one of two values, conventionally written as 0 and 1.",
      "",
      "## Origin of the Term",
      "",
      "The term *bit* was coined by John Tukey and popularized by [Claude Shannon](../person/claude-shannon.md) in his 1948 paper. Shannon used the bit as the unit for [Entropy](./entropy.md) and channel capacity.",
      "",
      "## Bytes and Higher Units",
      "",
      "Eight bits make a byte, the standard unit for representing a character. Multiples (kilobit, megabit, gigabit) are used in data-rate measurement.",
    ].join("\n"),
  },
  {
    path: "wiki/concept/algorithm.md",
    props: {
      label: "Algorithm",
      subject_type: "concept",
      short_description: "Finite sequence of well-defined steps for solving a problem.",
    },
    body: [
      "An algorithm is a finite sequence of well-defined, computer-implementable instructions for solving a class of problems or performing a computation.",
      "",
      "## Formalization",
      "",
      "[Alan Turing](../person/alan-turing.md) gave the modern formal definition of an algorithm via the [Turing Machine](./turing-machine.md). The Church–Turing thesis equates the intuitive notion of \"effective procedure\" with Turing-computability.",
      "",
      "## Complexity",
      "",
      "Algorithms are analyzed in terms of their time and space complexity, typically expressed using big-O notation. [Andrey Kolmogorov](../person/andrey-kolmogorov.md) extended this with algorithmic information theory.",
    ].join("\n"),
  },
  {
    path: "wiki/organization/bell-labs.md",
    props: {
      label: "Bell Labs",
      subject_type: "organization",
      short_description: "American industrial research laboratory.",
    },
    body: [
      "Bell Telephone Laboratories (Bell Labs) was an American industrial research and scientific development company, originally part of AT&T. It produced foundational work in radio astronomy, the transistor, the laser, the photovoltaic cell, the charge-coupled device, and [Information Theory](../concept/information-theory.md).",
      "",
      "## Notable Researchers",
      "",
      "Researchers who worked at Bell Labs include [Claude Shannon](../person/claude-shannon.md), Walter Brattain, John Bardeen, William Shockley, and Dennis Ritchie. Shannon's *A Mathematical Theory of Communication* was published in the Bell System Technical Journal.",
      "",
      "## Murray Hill",
      "",
      "The flagship research site is in Murray Hill, New Jersey. Many of the lab's foundational discoveries were made there.",
    ].join("\n"),
  },
  {
    path: "wiki/organization/bletchley-park.md",
    props: {
      label: "Bletchley Park",
      subject_type: "organization",
      short_description: "World War II codebreaking centre in Buckinghamshire, England.",
    },
    body: [
      "Bletchley Park was the principal centre of Allied code-breaking during the Second World War. It was the workplace of cryptanalysts who deciphered the Enigma cipher used by Nazi Germany.",
      "",
      "## Hut 8 and Enigma",
      "",
      "[Alan Turing](../person/alan-turing.md) led Hut 8, which focused on naval Enigma. The bombe machine, designed by Turing, mechanized the search for Enigma settings.",
      "",
      "## Historical Significance",
      "",
      "The intelligence produced at Bletchley Park, codenamed Ultra, is credited with shortening the war by two to four years. Its existence remained secret until the 1970s.",
    ].join("\n"),
  },
  {
    path: "wiki/organization/mit.md",
    props: {
      label: "MIT",
      subject_type: "organization",
      short_description: "Massachusetts Institute of Technology, private research university.",
    },
    body: [
      "The Massachusetts Institute of Technology (MIT) is a private research university in Cambridge, Massachusetts. It is known for its strength in science, engineering, mathematics, and economics.",
      "",
      "## Affiliated Researchers",
      "",
      "[Claude Shannon](../person/claude-shannon.md), [Norbert Wiener](../person/norbert-wiener.md), and many other founders of computing and information theory had long associations with MIT.",
      "",
      "## Notable Programs",
      "",
      "MIT's Computer Science and Artificial Intelligence Laboratory (CSAIL) is one of the largest academic AI research centres in the world.",
    ].join("\n"),
  },
];

// ─── Setup ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.ARKEON_WIKI_EMBEDDER = "onnx";
  process.env.ARKEON_WIKI_MODELS_DIR = join(homedir(), ".arkeon-wiki", "models");
  resetEmbedder();

  const base = join(tmpdir(), `arkeon-journey-${randomBytes(4).toString("hex")}`);
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

  // Seed the corpus before registering the space so reconciliation
  // picks it all up at once.
  for (const w of CORPUS) writeWiki(w.path, w.props, w.body);

  const created = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "journey-space", watch_dir: testDir }),
  });
  spaceId = ((await created.json()) as { id: string }).id;

  // Wait for all wikis to land in entities.
  const wikiDeadline = Date.now() + 60_000;
  while (Date.now() < wikiDeadline) {
    const wikis = await api(
      `/entities?type=wiki&space_id=${spaceId}&limit=100`,
    );
    if ((wikis.entities ?? []).length === CORPUS.length) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const wikis = await api(
    `/entities?type=wiki&space_id=${spaceId}&limit=100`,
  );
  expect(wikis.entities).toHaveLength(CORPUS.length);

  // Wait for the embedder to be ready (model load on cold cache may
  // take 60-90s; warm cache is ~2s).
  const embedder = await getEmbedder();
  const warmDeadline = Date.now() + 5 * 60_000;
  while (Date.now() < warmDeadline) {
    if (embedder.state() === "ready") break;
    if (embedder.state() === "failed") throw new Error("OnnxEmbedder failed to load");
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(embedder.state()).toBe("ready");

  // Drain the queue. With 15 wikis × ~5 chunks × ~50ms each, this is
  // a few seconds on warm-ORT cache.
  await waitForDrain(5 * 60_000);
  const stats = await queueStats();
  expect(stats.pending).toBe(0);
  expect(stats.in_flight).toBe(0);
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

// ─── Tests ──────────────────────────────────────────────────────────

describe("full-journey: corpus shape and embedding coverage", () => {
  it("every wiki has at least one chunk", async () => {
    // Assert via vector search with a very generic query — every wiki
    // should be retrievable somehow with limit=100.
    const hits = await vectorSearch("introduction", 100);
    const labelsHit = new Set(hits.map((h) => h.label));
    for (const w of CORPUS) {
      expect(labelsHit.has(w.props.label as string)).toBe(true);
    }
  });

  it("returns hits with sensible shape across the corpus", async () => {
    const hits = await vectorSearch("research", 30);
    expect(hits.length).toBeGreaterThan(0);
    // Wiki-level hits: at most one per entity, body present, frontmatter
    // parsed, similarity in range.
    const seen = new Set<string>();
    for (const h of hits) {
      expect(seen.has(h.entity_id)).toBe(false);
      seen.add(h.entity_id);
      expect(typeof h.label).toBe("string");
      expect(h.body.length).toBeGreaterThan(0);
      expect(h.frontmatter).toBeTypeOf("object");
      expect(h.similarity).toBeGreaterThanOrEqual(-1);
      expect(h.similarity).toBeLessThanOrEqual(1);
    }
  });
});

describe("full-journey: semantic ranking", () => {
  // Each query has an expected top-1 label. The query is phrased so it
  // does NOT contain the wiki's label as a substring — pure substring
  // matching wouldn't find it. This is a real semantic test.
  const cases: Array<{ q: string; expected: string }> = [
    { q: "father of information theory", expected: "Claude Shannon" },
    { q: "British computer science pioneer who broke German codes", expected: "Alan Turing" },
    { q: "Hungarian-American polymath who founded modern computer architecture", expected: "John von Neumann" },
    { q: "founder of the study of feedback and control systems", expected: "Norbert Wiener" },
    { q: "abstract mathematical model of computation with an infinite tape", expected: "Turing Machine" },
    { q: "measure of uncertainty in a probability distribution", expected: "Entropy" },
    { q: "smallest unit of digital information, two possible values", expected: "Bit" },
    { q: "step-by-step procedure for solving a problem", expected: "Algorithm" },
    { q: "study of self-regulating purposive systems", expected: "Cybernetics" },
    { q: "World War II Allied codebreaking centre in England", expected: "Bletchley Park" },
    { q: "industrial laboratory where the transistor was invented", expected: "Bell Labs" },
    { q: "Soviet mathematician who founded modern probability theory", expected: "Andrey Kolmogorov" },
  ];

  for (const c of cases) {
    it(`ranks "${c.expected}" first for "${c.q}"`, async () => {
      const hits = await vectorSearch(c.q, 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].label).toBe(c.expected);
    });
  }
});

describe("full-journey: discrimination + edge behaviour", () => {
  it("repeated identical queries return identical top-1 (determinism)", async () => {
    const a = await vectorSearch("father of information theory", 1);
    const b = await vectorSearch("father of information theory", 1);
    expect(a[0]?.entity_id).toBe(b[0]?.entity_id);
    expect(a[0]?.similarity).toBeCloseTo(b[0]?.similarity ?? -1, 6);
  });

  it("discriminates between adjacent topics: 'feedback' favours Cybernetics over Information Theory", async () => {
    const hits = await vectorSearch("feedback in regulatory systems", 5);
    const cybIdx = hits.findIndex((h) => h.label === "Cybernetics");
    const itIdx = hits.findIndex((h) => h.label === "Information Theory");
    expect(cybIdx).toBeGreaterThanOrEqual(0);
    if (itIdx >= 0) {
      expect(cybIdx).toBeLessThan(itIdx);
    }
  });

  it("a query about a genuinely irrelevant topic returns lower similarity than on-topic queries", async () => {
    const onTopic = await vectorSearch("Shannon entropy and information content", 1);
    const offTopic = await vectorSearch(
      "best recipes for chocolate chip cookies and baking tips",
      1,
    );
    expect(onTopic[0]?.similarity ?? 0).toBeGreaterThan(offTopic[0]?.similarity ?? 0);
  });

  it("query/document prefix asymmetry — same text as query vs document differs", async () => {
    // The model applies different prefixes; embedding the same string
    // as document then querying with it should still rank it highly,
    // but the ranking order across the corpus may differ from
    // embedding it as a query against itself. We just assert the
    // self-match is still in the top-3 (sanity), not that it's #1
    // (the prefix difference is real).
    const hits = await vectorSearch(
      "Claude Elwood Shannon was an American mathematician",
      3,
    );
    expect(hits.some((h) => h.label === "Claude Shannon")).toBe(true);
  });

  it("hybrid mode: keyword and vector independently surface Shannon for 'Shannon'", async () => {
    const data = await api(
      `/search?space_id=${spaceId}&q=Shannon&mode=both&limit=5`,
    );
    expect(data.keyword.hits.some((h: any) => h.label === "Claude Shannon")).toBe(true);
    expect(data.vector.hits.some((h: any) => h.label === "Claude Shannon")).toBe(true);
  });
});
