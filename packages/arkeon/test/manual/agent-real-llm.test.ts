// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 3: real-LLM end-to-end demo.
 *
 * Drives runAgent against an actual provider (OpenAI by default) using
 * the declarative built-in `ingestor` role from agents/builtins.ts.
 * This exercises the whole config → role-builder → runtime → tools
 * stack, exactly the way the daemon-driven ingestor worker will.
 *
 * Skipped automatically when no API key is set. Invoke explicitly:
 *
 *   npm run test:manual -w packages/arkeon
 *
 * Drop your key into a .env file at the repo root (auto-loaded), or
 * set OPENAI_API_KEY / ANTHROPIC_API_KEY in the shell. Override the
 * provider/model/baseURL with AGENT_DEMO_PROVIDER, AGENT_DEMO_MODEL,
 * AGENT_DEMO_BASE_URL.
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

// Load .env files in precedence order: shell > repo .env > ~/.arkeon-wiki/.env.
// The repo's .env is at ../../../../ from this file (worktree root).
loadAgentEnv({ spaceDir: resolve(__dirname, "../../../..") });

const API_PORT = 18799;

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

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let space: Space;

beforeAll(async () => {
  if (!HAS_KEY) return;

  const base = join(tmpdir(), `arkeon-real-llm-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });
  mkdirSync(join(testDir, "sources"), { recursive: true });
  mkdirSync(join(testDir, ".arkeon"), { recursive: true });

  // Plant agents.yaml BEFORE the space is registered, so the
  // per-space scheduler's probe finds a buildable role and the
  // auto-trigger worker actually starts.
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
    body: JSON.stringify({ name: "real-llm-space", watch_dir: testDir }),
  });
  const json = (await spaceRes.json()) as { id: string };
  space = { id: json.id, name: "real-llm-space", watch_dir: testDir };
}, 60_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
}, 30_000);

describe.skipIf(!HAS_KEY)("real-LLM ingestor agent", () => {
  it(
    "uses the built-in ingestor role to extract subjects from a source",
    async () => {
      const sourcePath = "sources/shannon-bio.md";
      writeFileSync(
        join(testDir, sourcePath),
        [
          "# Founding Information Theory",
          "",
          "Claude Shannon was an American mathematician and electrical engineer.",
          "His 1948 paper, *A Mathematical Theory of Communication*, founded the",
          "field of information theory. He spent most of his career at Bell Labs,",
          "where he also did pioneering work on cryptography during World War II.",
          "",
        ].join("\n"),
      );

      // Auto-trigger path: dropping the file is enough — the watcher
      // will enqueue, the scheduler will run the ingestor. We just
      // wait for the agent_runs row to register completion.
      const sql = createSql();
      const deadline = Date.now() + 120_000;
      let completed = false;
      while (Date.now() < deadline) {
        const rows = await sql`
          SELECT status FROM agent_runs
          WHERE role = ${"ingestor"} AND idempotency_key = ${sourcePath}
        `;
        if (rows[0]?.status === "completed") {
          completed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(completed).toBe(true);

      // ── Report ──────────────────────────────────────────────────
      console.log("\n──────── REAL-LLM AGENT RESULT (auto-trigger) ────────");
      console.log(`provider:  ${PROVIDER}`);
      console.log(`model:     ${MODEL}`);
      console.log(`role:      ingestor (built-in)`);
      console.log(`completed: ${completed ? "✓" : "✗"}`);
      console.log("\nWikis on disk:");
      const wikiDir = join(testDir, "wiki");
      function walk(dir: string, prefix = "  ") {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(path, prefix + "  ");
          } else if (entry.name.endsWith(".md")) {
            const fm = readFileSync(path, "utf-8");
            const labelMatch = fm.match(/label:\s*(.+)/);
            console.log(
              `${prefix}${path.replace(testDir + "/", "")}  →  ${labelMatch?.[1] ?? "(no label)"}`,
            );
          }
        }
      }
      walk(wikiDir);
      console.log("──────────────────────────────────────────────────────\n");

      // ── Lenient assertions ──────────────────────────────────────
      const wikiFiles: string[] = [];
      function findMd(dir: string) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) findMd(p);
          else if (entry.name.endsWith(".md")) wikiFiles.push(p);
        }
      }
      findMd(wikiDir);
      expect(wikiFiles.length).toBeGreaterThan(0);

      // Ingestor writes wiki bodies, not placeholders. Each generated
      // wiki should have a non-trivial body and at least one wiki has
      // a markdown link back to the source path (provenance).
      const bodyContents = wikiFiles.map((p) => readFileSync(p, "utf-8"));
      const withBody = bodyContents.filter((s) => {
        const parts = s.split(/^---$/m);
        return parts.length >= 3 && parts[2].trim().length > 50;
      });
      expect(withBody.length).toBeGreaterThan(0);

      const withSourceBacklink = bodyContents.filter((s) =>
        s.includes(sourcePath),
      );
      expect(withSourceBacklink.length).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "amends an existing wiki when a new source mentions the same subject",
    async () => {
      // Plant a SECOND source that mentions Claude Shannon (already
      // ingested by the previous test) plus a new subject the
      // existing space hasn't seen. The ingestor should edit_file
      // Shannon's wiki to weave in the new material — preserving the
      // wiki's id and the original Bell-Labs paragraph — and use
      // edit_file CREATE mode to write a fresh wiki for the new subject.
      const shannonPath = join(testDir, "wiki/person/claude-shannon.md");
      expect(existsSync(shannonPath)).toBe(true);

      const before = readFileSync(shannonPath, "utf-8");
      const beforeId = before.match(/^id:\s*(\S+)/m)?.[1];
      expect(beforeId).toBeTruthy();
      const beforeBodyLen = before.split(/^---$/m)[2]?.length ?? 0;
      expect(beforeBodyLen).toBeGreaterThan(50);

      const newSourcePath = "sources/shannon-circuits.md";
      writeFileSync(
        join(testDir, newSourcePath),
        [
          "# Boolean Circuits",
          "",
          "Claude Shannon's 1937 master's thesis at MIT showed that boolean",
          "algebra could be applied to the design of electrical relay",
          "circuits. The thesis is widely regarded as one of the most",
          "important master's theses ever written and laid the groundwork",
          "for digital circuit design.",
          "",
        ].join("\n"),
      );

      // Wait for the auto-trigger to finish ingesting the new source.
      const sql = createSql();
      const deadline = Date.now() + 120_000;
      let completed = false;
      while (Date.now() < deadline) {
        const rows = await sql`
          SELECT status FROM agent_runs
          WHERE role = ${"ingestor"} AND idempotency_key = ${newSourcePath}
        `;
        if (rows[0]?.status === "completed") {
          completed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(completed).toBe(true);

      console.log("\n──────── EDIT-EXISTING REAL-LLM RESULT (auto-trigger) ────────");
      console.log(`new source: ${newSourcePath}`);
      console.log(`completed:  ✓`);
      console.log("──────────────────────────────────────────────────────────\n");

      // ── Lenient assertions ──────────────────────────────────────
      // Shannon's wiki should still exist and have the SAME id.
      const after = readFileSync(shannonPath, "utf-8");
      const afterId = after.match(/^id:\s*(\S+)/m)?.[1];
      expect(afterId).toBe(beforeId);

      // The body should have grown — new source's material is woven in.
      const afterBodyLen = after.split(/^---$/m)[2]?.length ?? 0;
      expect(afterBodyLen).toBeGreaterThan(beforeBodyLen);

      // The new source path should appear somewhere in the wiki body
      // (the ingestor's instructions tell it to include a backlink).
      const sawNewSourceInShannon =
        after.includes(newSourcePath) ||
        after.includes("shannon-circuits");
      expect(sawNewSourceInShannon).toBe(true);

      // Original Bell-Labs material should still be present (the edit
      // should weave in, not replace).
      expect(after.toLowerCase()).toContain("bell labs");
    },
    180_000,
  );

  it(
    "auto-fires the ingestor when a source file lands (no explicit trigger)",
    async () => {
      // The previous tests called runAgent directly. This one drops a
      // file into the watched directory and waits — the watcher →
      // scheduler → runAgent chain should run the ingestor without
      // any explicit invocation. Validates the daemon-side auto-
      // trigger path that production users will rely on. (agents.yaml
      // was planted in beforeAll so the per-space scheduler started
      // a worker.)

      // Drop a brand-new source file. No explicit runAgent call.
      const sourcePath = "sources/auto-trigger-demo.md";
      writeFileSync(
        join(testDir, sourcePath),
        [
          "# Hedy Lamarr",
          "",
          "Hedy Lamarr was an Austrian-American actress and inventor whose",
          "work on frequency-hopping radio guidance systems during World War",
          "II laid groundwork for modern wireless communication technologies",
          "including Wi-Fi and Bluetooth.",
          "",
        ].join("\n"),
      );

      // Wait for the daemon to: see the file → enqueue → run the
      // ingestor → finish (agent_runs marked completed). Watching for
      // agent_runs is the right signal — the wiki write happens
      // mid-run, so a wiki-on-disk check can be observed before the
      // run record exists. Generous timeout: real LLM calls take
      // 30-60s plus the watcher's ~500ms debounce.
      const sql = createSql();
      const deadline = Date.now() + 120_000;
      let completedRun:
        | { idempotency_key: string; status: string }
        | null = null;
      while (Date.now() < deadline) {
        const rows = await sql`
          SELECT idempotency_key, status FROM agent_runs
          WHERE role = ${"ingestor"} AND idempotency_key = ${sourcePath}
        `;
        const r = rows[0] as
          | { idempotency_key: string; status: string }
          | undefined;
        if (r && r.status === "completed") {
          completedRun = r;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // Diagnostic dump regardless of pass/fail.
      const queueRows = await sql`
        SELECT trigger_path, attempts, last_error, started_at
        FROM agent_queue
        WHERE space_id = ${space.id}
      `;
      const allRuns = await sql`
        SELECT idempotency_key, status FROM agent_runs
        WHERE role = ${"ingestor"}
        ORDER BY finished_at DESC LIMIT 5
      `;
      console.log("\n──────── AUTO-TRIGGER REAL-LLM RESULT ────────");
      console.log(`source dropped: ${sourcePath}`);
      console.log(`completed run:  ${completedRun ? "✓" : "✗"}`);
      console.log(`queue rows:     ${queueRows.length} pending/in-flight`);
      console.log(`recent runs:    ${allRuns.length}`);
      for (const r of allRuns) {
        console.log(`  - ${r.status}  ${r.idempotency_key}`);
      }
      console.log("──────────────────────────────────────────────\n");

      // Lenient: the LLM might pick a slightly different file path
      // (e.g., wiki/person/lamarr.md). Walk wiki/ for any file
      // mentioning Hedy Lamarr.
      const allWikiFiles: string[] = [];
      function walkMd(dir: string) {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walkMd(p);
          else if (entry.name.endsWith(".md")) allWikiFiles.push(p);
        }
      }
      walkMd(join(testDir, "wiki"));

      const hedyWiki = allWikiFiles.find((p) => {
        const c = readFileSync(p, "utf-8").toLowerCase();
        return c.includes("hedy lamarr") || c.includes("frequency-hopping");
      });
      expect(hedyWiki).toBeTruthy();
      expect(completedRun).toBeTruthy();
    },
    180_000,
  );
});
