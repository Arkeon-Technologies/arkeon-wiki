// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Iterative real-LLM test for the cron-driven writer.
 *
 * Drops three Sherlock Holmes excerpts (Project Gutenberg eBook 1661)
 * into a watched space, one at a time, running the writer between
 * each. The interesting signal is whether the writer EXTENDS existing
 * articles when a new source bears on a question already answered, or
 * CREATES new ones when a new question is raised.
 *
 * Three Holmes stories share recurring characters (Holmes, Watson) and
 * recurring themes (deduction-by-trifles, the agency of women, the
 * client typology). Tick 1 sees only Story A; tick 2 sees Story A's
 * articles plus Story B's source; tick 3 sees both prior tickings'
 * articles plus Story C's source. By the end we should see at least
 * one article that's been touched by multiple sources — that's the
 * horizontal-article growth signal the new role exists for.
 *
 * Reports per-tick state: article count, total wiki bytes, articles
 * touched this tick, source citations, plus a final cross-source
 * coverage report.
 *
 * Skipped automatically when no API key is set. Cost ~$0.05–$0.15
 * with gpt-5-mini (3 writer ticks).
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
import { buildAgentRole } from "../../src/server/agents/role-builder.js";
import { loadAgentConfig } from "../../src/server/agents/config.js";
import { runAgent } from "../../src/server/agents/runtime.js";
import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import { createSql } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";

loadAgentEnv({ spaceDir: resolve(__dirname, "../../../..") });

const API_PORT = 18803;

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

// ── Gutenberg fetch + slicing ──────────────────────────────────────

const HOLMES_URL = "https://www.gutenberg.org/cache/epub/1661/pg1661.txt";
const HOLMES_CACHE = join(tmpdir(), "arkeon-gutenberg-1661.txt");

async function fetchHolmesBook(): Promise<string> {
  if (existsSync(HOLMES_CACHE)) return readFileSync(HOLMES_CACHE, "utf-8");
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
  title: string;
  body: string;
}

function sliceStory(book: string, startMarker: string, cap = 4500): string {
  const start = book.indexOf(startMarker);
  if (start < 0) throw new Error(`Marker not found: ${startMarker}`);
  return book.slice(start, start + cap);
}

function buildExcerpts(book: string): Excerpt[] {
  return [
    {
      filename: "sources/holmes-1-scandal-bohemia.md",
      title: "A Scandal in Bohemia",
      body:
        "# A Scandal in Bohemia (excerpt)\n\nFrom Arthur Conan Doyle's *The Adventures of Sherlock Holmes* (Project Gutenberg eBook 1661).\n\n" +
        sliceStory(book, "To Sherlock Holmes she is always _the_ woman"),
    },
    {
      filename: "sources/holmes-2-red-headed-league.md",
      title: "The Red-Headed League",
      body:
        "# The Red-Headed League (excerpt)\n\nFrom Arthur Conan Doyle's *The Adventures of Sherlock Holmes* (Project Gutenberg eBook 1661).\n\n" +
        sliceStory(book, "I had called upon my friend, Mr. Sherlock Holmes,"),
    },
    {
      filename: "sources/holmes-3-case-of-identity.md",
      title: "A Case of Identity",
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

  const book = await fetchHolmesBook();
  excerpts = buildExcerpts(book);

  const base = join(tmpdir(), `arkeon-iter-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });
  mkdirSync(join(testDir, "sources"), { recursive: true });
  mkdirSync(join(testDir, ".arkeon"), { recursive: true });

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
    body: JSON.stringify({ name: "iter-space", watch_dir: testDir }),
  });
  const json = (await spaceRes.json()) as { id: string };
  space = { id: json.id, name: "iter-space", watch_dir: testDir };
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

// ── State scanning ─────────────────────────────────────────────────

interface ArticleState {
  relPath: string;
  bytes: number;
  label: string;
  body: string;
  citedSources: Set<string>;
}

function listArticles(): ArticleState[] {
  const wikiDir = join(testDir, "wiki");
  const out: ArticleState[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) {
        const content = readFileSync(p, "utf-8");
        const labelMatch = content.match(/^label:\s*(.+)$/m);
        const parts = content.split(/^---$/m);
        const body = parts[2] ?? "";
        const cited = new Set<string>();
        for (const ex of excerpts) {
          if (body.includes(ex.filename)) cited.add(ex.filename);
        }
        out.push({
          relPath: p.replace(testDir + "/", ""),
          bytes: content.length,
          label: (labelMatch?.[1] ?? "(no label)")
            .trim()
            .replace(/^["']|["']$/g, ""),
          body,
          citedSources: cited,
        });
      }
    }
  }
  walk(wikiDir);
  return out;
}

async function waitForFileEntity(sourcePath: string): Promise<void> {
  const sql = createSql();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await sql`
      SELECT id FROM entities
      WHERE space_id = ${space.id} AND source_path = ${sourcePath}
    `;
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Watcher did not sync ${sourcePath} within 10s`);
}

// ── The test ───────────────────────────────────────────────────────

interface TickReport {
  excerpt: string;
  steps: number;
  edits: number;
  tokens: number;
  durationMs: number;
  totalArticles: number;
  totalBytes: number;
  newArticlePaths: string[];
  modifiedArticlePaths: string[];
}

describe.skipIf(!HAS_KEY)("real-LLM writer agent — iterative growth", () => {
  it(
    "extends and creates articles as Holmes excerpts arrive one by one",
    async () => {
      const config = loadAgentConfig({ spaceDir: testDir });
      const role = buildAgentRole("writer", config);

      const tickReports: TickReport[] = [];
      let prevSnapshot = new Map<string, { bytes: number }>();

      for (const ex of excerpts) {
        // Drop the next source.
        writeFileSync(join(testDir, ex.filename), ex.body, "utf-8");
        await waitForFileEntity(ex.filename);

        console.log(
          `\n══════════ TICK ${tickReports.length + 1}: ${ex.title} ══════════`,
        );

        // Run the writer in cron mode (no triggerPath).
        const t0 = Date.now();
        const result = await runAgent(
          role,
          { space, meta: {} },
          ALL_TOOLS,
          {},
        );
        const durationMs = Date.now() - t0;

        const after = listArticles();
        const newPaths: string[] = [];
        const modifiedPaths: string[] = [];
        for (const a of after) {
          const before = prevSnapshot.get(a.relPath);
          if (!before) newPaths.push(a.relPath);
          else if (before.bytes !== a.bytes) modifiedPaths.push(a.relPath);
        }
        prevSnapshot = new Map(after.map((a) => [a.relPath, { bytes: a.bytes }]));

        const report: TickReport = {
          excerpt: ex.title,
          steps: result.steps,
          edits: result.edits.length,
          tokens: result.usage?.totalTokens ?? 0,
          durationMs,
          totalArticles: after.length,
          totalBytes: after.reduce((sum, a) => sum + a.bytes, 0),
          newArticlePaths: newPaths,
          modifiedArticlePaths: modifiedPaths,
        };
        tickReports.push(report);

        console.log(
          `steps=${report.steps}  edits=${report.edits}  tokens=${report.tokens}  ` +
            `time=${(durationMs / 1000).toFixed(1)}s`,
        );
        console.log(
          `articles total: ${report.totalArticles}  (${report.totalBytes} bytes)`,
        );
        if (newPaths.length > 0) {
          console.log(`  + new: ${newPaths.join(", ")}`);
        }
        if (modifiedPaths.length > 0) {
          console.log(`  ~ modified: ${modifiedPaths.join(", ")}`);
        }
      }

      // ── Final report ──────────────────────────────────────────────
      const finalArticles = listArticles();
      const totalTokens = tickReports.reduce((s, r) => s + r.tokens, 0);
      const totalDurationS = tickReports.reduce(
        (s, r) => s + r.durationMs / 1000,
        0,
      );
      const multiSourceArticles = finalArticles.filter(
        (a) => a.citedSources.size > 1,
      );

      console.log("\n══════════ FINAL CORPUS ══════════");
      console.log(`total ticks:          ${tickReports.length}`);
      console.log(`total tokens:         ${totalTokens}`);
      console.log(`total wall time:      ${totalDurationS.toFixed(1)}s`);
      console.log(`final articles:       ${finalArticles.length}`);
      console.log(
        `multi-source coverage: ${multiSourceArticles.length} article(s) cite >1 source`,
      );
      console.log("");
      console.log("Articles (sources cited):");
      for (const a of finalArticles) {
        const cited = [...a.citedSources]
          .map((p) => p.replace("sources/", "").replace(".md", ""))
          .join(", ");
        console.log(
          `  ${a.relPath}  [${cited || "(none)"}]  — ${a.label} (${a.bytes} bytes)`,
        );
      }
      console.log("");
      console.log("Per-tick deltas:");
      for (const r of tickReports) {
        console.log(
          `  ${r.excerpt.padEnd(28)}  +${r.newArticlePaths.length} new, ` +
            `~${r.modifiedArticlePaths.length} modified, ` +
            `${r.totalArticles} total`,
        );
      }
      console.log("══════════════════════════════════\n");

      // ── Assertions (lenient — model behavior varies) ──────────────
      expect(finalArticles.length).toBeGreaterThan(0);
      // Each tick should make at least one edit (the prompt tells the
      // writer to no-op only when there's nothing to do, and there's
      // always something to do here).
      for (const r of tickReports) {
        expect(r.edits).toBeGreaterThan(0);
      }
      // The whole point of horizontal articles: at least one article
      // should end up cited by multiple sources after three thematically
      // related Holmes excerpts. Holmes/Watson/deduction are obvious
      // candidates. If this assertion fails, the writer is treating
      // each source as its own silo — which is exactly the pattern the
      // new role is supposed to break.
      expect(multiSourceArticles.length).toBeGreaterThanOrEqual(1);
    },
    600_000, // 10-min cap; ~30s per tick × 3 + slack
  );
});
