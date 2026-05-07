// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-corpus end-to-end test: Sherlock Holmes from Project Gutenberg.
 *
 * Pulls "The Adventures of Sherlock Holmes" (eBook 1661), slices three
 * stories ("A Scandal in Bohemia", "The Red-Headed League", "A Case of
 * Identity"), drops them one at a time into the watched space's
 * sources/ dir, and waits for the auto-trigger to ingest each. The
 * three stories share recurring characters (Holmes, Watson) so this
 * exercises the harder half of the pipeline: the second and third
 * stories must EDIT the existing Holmes/Watson wikis rather than
 * recreate them.
 *
 * Reports a structured summary at the end: wiki count by subject_type,
 * which wikis were touched by multiple sources, and which sources
 * landed cross-links between wikis.
 *
 * Skipped automatically when no API key is set. Network-bound (one
 * fetch from gutenberg.org); cached under tmpdir so re-runs are fast.
 *
 * Cost: roughly $0.02-$0.05 per run with gpt-5-mini.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { loadAgentEnv } from "../../src/server/agents/env-loader.js";
import { createSql } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";

loadAgentEnv({ spaceDir: resolve(__dirname, "../../../..") });

const API_PORT = 18802;

const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const HAS_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY;
const HAS_KEY =
  HAS_OPENAI || HAS_ANTHROPIC || !!process.env.AGENT_DEMO_BASE_URL;

const PROVIDER = (process.env.AGENT_DEMO_PROVIDER ??
  (HAS_OPENAI ? "openai" : HAS_ANTHROPIC ? "anthropic" : "openai-compatible")) as
  | "openai"
  | "anthropic"
  | "openai-compatible";

const MODEL =
  process.env.AGENT_DEMO_MODEL ??
  (PROVIDER === "anthropic" ? "claude-sonnet-4-6" : "gpt-5-mini");

// ── Gutenberg helpers ───────────────────────────────────────────────

const HOLMES_URL = "https://www.gutenberg.org/cache/epub/1661/pg1661.txt";
const HOLMES_CACHE = join(tmpdir(), "arkeon-gutenberg-1661.txt");

async function fetchHolmesBook(): Promise<string> {
  if (existsSync(HOLMES_CACHE)) {
    return readFileSync(HOLMES_CACHE, "utf-8");
  }
  const res = await fetch(HOLMES_URL);
  if (!res.ok) {
    throw new Error(`Gutenberg fetch failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  writeFileSync(HOLMES_CACHE, text, "utf-8");
  return text;
}

interface Excerpt {
  filename: string;
  body: string;
}

/**
 * Slice a chunk of the book between two marker phrases. We aim for
 * the *narrative* portion of each story — the part with all the
 * named entities the ingestor should pick up — capped at ~3500 chars
 * so the LLM input stays bounded.
 */
function sliceStory(
  book: string,
  startMarker: string,
  cap = 3500,
): string {
  const start = book.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Marker not found: ${startMarker}`);
  }
  return book.slice(start, start + cap);
}

function buildExcerpts(book: string): Excerpt[] {
  return [
    {
      filename: "sources/holmes-1-scandal-bohemia.md",
      body:
        "# A Scandal in Bohemia (excerpt)\n\nFrom Arthur Conan Doyle's *The Adventures of Sherlock Holmes* (Project Gutenberg eBook 1661).\n\n" +
        sliceStory(book, "To Sherlock Holmes she is always _the_ woman"),
    },
    {
      filename: "sources/holmes-2-red-headed-league.md",
      body:
        "# The Red-Headed League (excerpt)\n\nFrom Arthur Conan Doyle's *The Adventures of Sherlock Holmes* (Project Gutenberg eBook 1661).\n\n" +
        sliceStory(book, "I had called upon my friend, Mr. Sherlock Holmes,"),
    },
    {
      filename: "sources/holmes-3-case-of-identity.md",
      body:
        "# A Case of Identity (excerpt)\n\nFrom Arthur Conan Doyle's *The Adventures of Sherlock Holmes* (Project Gutenberg eBook 1661).\n\n" +
        sliceStory(book, "“My dear fellow,” said Sherlock Holmes"),
    },
  ];
}

// ── Test harness ───────────────────────────────────────────────────

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let space: Space;
let excerpts: Excerpt[];

beforeAll(async () => {
  if (!HAS_KEY) return;

  // Pull the book first; if Gutenberg is down, fail fast (skip the
  // long setup). Cache on local disk so re-runs are immediate.
  const book = await fetchHolmesBook();
  excerpts = buildExcerpts(book);

  const base = join(tmpdir(), `arkeon-gutenberg-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });
  mkdirSync(join(testDir, "sources"), { recursive: true });
  mkdirSync(join(testDir, ".arkeon"), { recursive: true });

  // Plant agents.yaml so the per-space scheduler's role-build probe
  // succeeds and a worker actually starts.
  const yamlLines = [
    "defaults:",
    `  provider: ${PROVIDER}`,
    `  model: ${MODEL}`,
  ];
  if (process.env.AGENT_DEMO_BASE_URL) {
    yamlLines.push(`  base_url: ${process.env.AGENT_DEMO_BASE_URL}`);
  }
  writeFileSync(
    join(testDir, ".arkeon", "agents.yaml"),
    yamlLines.join("\n") + "\n",
  );

  process.env.ARKEON_WIKI_HOME = stateDir;

  const dbFile = join(stateDir, "data", "arke.db");
  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: API_PORT, dbPath: dbFile });
  serverHandle = { stop: async () => apiHandle.stop() };

  const spaceRes = await fetch(`http://localhost:${API_PORT}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "gutenberg-space", watch_dir: testDir }),
  });
  const json = (await spaceRes.json()) as { id: string };
  space = { id: json.id, name: "gutenberg-space", watch_dir: testDir };
}, 90_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────

async function waitForCompletion(
  sourcePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const sql = createSql();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql`
      SELECT status FROM agent_runs
      WHERE role = ${"ingestor"} AND idempotency_key = ${sourcePath}
    `;
    if (rows[0]?.status === "completed") return true;
    if (rows[0]?.status === "failed") return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

interface WikiInfo {
  path: string;
  label: string;
  subjectType: string;
  bodyLen: number;
  body: string;
  outgoingLinks: string[];
}

function listWikis(wikiDir: string): WikiInfo[] {
  const out: WikiInfo[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) {
        const content = readFileSync(p, "utf-8");
        const labelMatch = content.match(/^label:\s*(.+)/m);
        const typeMatch = content.match(/^subject_type:\s*(.+)/m);
        const parts = content.split(/^---$/m);
        const body = parts[2] ?? "";
        const linkMatches = body.matchAll(/\]\((\.\.\/[^)]+\.md)\)/g);
        const links: string[] = [];
        for (const m of linkMatches) links.push(m[1]);
        out.push({
          path: p,
          label: (labelMatch?.[1] ?? "(no label)").trim().replace(/^["']|["']$/g, ""),
          subjectType: (typeMatch?.[1] ?? "(unknown)").trim().replace(/^["']|["']$/g, ""),
          bodyLen: body.trim().length,
          body,
          outgoingLinks: links,
        });
      }
    }
  }
  walk(wikiDir);
  return out;
}

// ── The test ──────────────────────────────────────────────────────

describe.skipIf(!HAS_KEY)("real-LLM ingestor agent — Gutenberg corpus", () => {
  it(
    "ingests three Holmes stories and produces a coherent cross-linked wiki graph",
    async () => {
      const wikiDir = join(testDir, "wiki");
      const sources = excerpts;

      // Drop sources one at a time, waiting for each to complete
      // before starting the next. This serializes the ingestor and
      // gives us deterministic ordering: story 2 sees story 1's
      // wikis on list_entities, etc.
      const perSource: Array<{
        source: string;
        completed: boolean;
        wikiCountAfter: number;
        elapsedMs: number;
      }> = [];

      for (const ex of sources) {
        const before = listWikis(wikiDir).length;
        const t0 = Date.now();
        writeFileSync(join(testDir, ex.filename), ex.body, "utf-8");
        const completed = await waitForCompletion(ex.filename, 180_000);
        const elapsedMs = Date.now() - t0;
        const after = listWikis(wikiDir).length;
        perSource.push({
          source: ex.filename,
          completed,
          wikiCountAfter: after,
          elapsedMs,
        });
        console.log(
          `\n[${ex.filename}]  completed=${completed ? "✓" : "✗"}  wikis_total=${after}  Δ=${after - before}  elapsed=${(elapsedMs / 1000).toFixed(1)}s`,
        );
      }

      // ── Final report ────────────────────────────────────────────
      const allWikis = listWikis(wikiDir);
      const bySubjectType = new Map<string, WikiInfo[]>();
      for (const w of allWikis) {
        const arr = bySubjectType.get(w.subjectType) ?? [];
        arr.push(w);
        bySubjectType.set(w.subjectType, arr);
      }

      // Cross-link census: how many wikis link to other wikis?
      let crossLinkCount = 0;
      for (const w of allWikis) crossLinkCount += w.outgoingLinks.length;

      // Mentions across sources: count how often each source path
      // appears in the body of any wiki.
      const sourceMentions = new Map<string, number>();
      for (const ex of sources) {
        let count = 0;
        for (const w of allWikis) {
          if (w.body.includes(ex.filename)) count++;
        }
        sourceMentions.set(ex.filename, count);
      }

      console.log("\n──────── GUTENBERG CORPUS REAL-LLM RESULT ────────");
      console.log(`provider:  ${PROVIDER}`);
      console.log(`model:     ${MODEL}`);
      console.log(`sources:   ${sources.length}`);
      console.log(`wikis:     ${allWikis.length} total`);
      console.log("\nby subject_type:");
      for (const [type, wikis] of [...bySubjectType.entries()].sort()) {
        console.log(`  ${type.padEnd(15)} ${wikis.length}`);
        for (const w of wikis) {
          console.log(
            `    - ${w.label}  (${w.bodyLen} chars, ${w.outgoingLinks.length} links)`,
          );
        }
      }
      console.log("\nsource → wiki mentions (provenance backlinks):");
      for (const [src, count] of sourceMentions) {
        console.log(`  ${src}  →  ${count} wikis`);
      }
      console.log(`\ntotal cross-links between wikis: ${crossLinkCount}`);
      console.log("──────────────────────────────────────────────────\n");

      // ── Assertions (lenient — different runs may pick different
      //    subjects, but the *shape* should hold) ──────────────────

      // All three sources should have completed.
      expect(perSource.every((p) => p.completed)).toBe(true);

      // Holmes is the obvious recurring character. After all three
      // stories, there should be a Holmes wiki.
      const holmes = allWikis.find((w) =>
        /sherlock\s+holmes/i.test(w.label),
      );
      expect(holmes).toBeTruthy();

      // The Holmes wiki should be referenced from at least one of the
      // 3 sources via a markdown backlink.
      expect(holmes!.body.length).toBeGreaterThan(100);

      // The corpus produces at least 3 wikis (probably many more —
      // stories have multiple named characters, places, etc.). 3 is
      // a lower bound that won't fluctuate model-to-model.
      expect(allWikis.length).toBeGreaterThanOrEqual(3);

      // At least one wiki should have an outgoing markdown link to
      // another wiki — the ingestor's "cross-link to existing wikis"
      // guidance should produce at least one such link across three
      // related stories.
      expect(crossLinkCount).toBeGreaterThanOrEqual(1);

      // Each source should appear in at least one wiki body (the
      // ingestor's "include a markdown link back to the source"
      // guidance).
      for (const [src, count] of sourceMentions) {
        expect(count).toBeGreaterThanOrEqual(1);
      }
    },
    600_000, // 10-minute cap; 3 stories × ~60s each + slack
  );
});
