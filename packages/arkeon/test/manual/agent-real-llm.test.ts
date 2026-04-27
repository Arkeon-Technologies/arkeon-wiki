// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 3: real-LLM end-to-end demo.
 *
 * Drives runAgent against an actual OpenAI/Anthropic model, with the
 * full ALL_TOOLS registry, against a tempdir space seeded with a
 * source file. Verifies the LLM can use the tool descriptions to:
 *   1. discover what already exists (list_wikis)
 *   2. read the source file (read_file)
 *   3. identify subjects and contribute them (contribute)
 *
 * Skipped automatically when no API key is set, so it doesn't break
 * the default suite. Invoke explicitly:
 *
 *   OPENAI_API_KEY=sk-... npm run test:manual -w packages/arkeon
 *
 * Override the model with AGENT_DEMO_MODEL (default: gpt-5-mini).
 * Override the provider with AGENT_DEMO_PROVIDER (openai|anthropic|
 * openai-compatible) and AGENT_DEMO_BASE_URL for openai-compatible.
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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { runAgent, type AgentRole } from "../../src/server/agents/runtime.js";
import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import type { ModelConfig } from "../../src/server/agents/model.js";
import { createSql } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";

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

function modelConfig(): ModelConfig {
  if (PROVIDER === "anthropic") {
    return { provider: "anthropic", id: MODEL, apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (PROVIDER === "openai-compatible") {
    return {
      provider: "openai-compatible",
      id: MODEL,
      baseURL: process.env.AGENT_DEMO_BASE_URL ?? "http://localhost:11434/v1",
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  return { provider: "openai", id: MODEL, apiKey: process.env.OPENAI_API_KEY };
}

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

describe.skipIf(!HAS_KEY)("real-LLM contributor agent", () => {
  it(
    "extracts subjects from a source file and contributes to the right wikis",
    async () => {
      // Seed a short source paragraph that mentions multiple distinct
      // subjects. Keep it small so token cost stays trivial.
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

      // Wait for the watcher to index the source so contribute() can
      // resolve source_id if the LLM passes one.
      const sql = createSql();
      const deadline = Date.now() + 5000;
      let sourceId: string | null = null;
      while (Date.now() < deadline) {
        const rows = await sql`
          SELECT id FROM entities WHERE space_id = ${space.id} AND source_path = ${sourcePath}
        `;
        if (rows.length > 0) {
          sourceId = rows[0].id as string;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(sourceId).toBeTruthy();

      const role: AgentRole = {
        name: "demo-contributor",
        model: modelConfig(),
        tools: ["list_wikis", "read_file", "contribute"],
        maxSteps: 12,
        buildPrompt: async () => ({
          system: [
            "You are a contributor agent for a wiki knowledge graph.",
            "",
            "Workflow:",
            "  1. Use list_wikis to see what already exists in this space.",
            "  2. Use read_file to read the source document at the given path.",
            "  3. Identify each distinct subject it discusses (people,",
            "     organizations, concepts, etc.).",
            "  4. For each subject, call contribute() with:",
            "       - subject.label: the canonical name",
            "       - subject.subject_type: 'person' | 'organization' |",
            "         'concept' | 'event' | etc.",
            "       - excerpt: a short verbatim or paraphrased sentence from",
            "         the source",
            "       - claim: a one-line summary of what the source establishes",
            "         about that subject",
            "       - source_id: the source entity id you were given",
            "  5. Stop when every distinct subject has been contributed.",
            "",
            "Do not write any wiki bodies — that is a separate agent's job.",
            "Be concise. Aim for at most 4 contribute calls.",
          ].join("\n"),
          prompt: [
            `Source path: ${sourcePath}`,
            `Source entity id: ${sourceId}`,
            "",
            "Identify subjects and contribute them.",
          ].join("\n"),
        }),
        idempotencyKey: () => ({ key: sourcePath, hash: "v1" }),
        concurrencyKey: ({ space: s }) => `demo::${s.id}`,
      };

      const result = await runAgent(role, { space }, ALL_TOOLS);

      // ── Report ──────────────────────────────────────────────────
      console.log("\n──────── REAL-LLM AGENT RESULT ────────");
      console.log(`provider:  ${PROVIDER}`);
      console.log(`model:     ${MODEL}`);
      console.log(`steps:     ${result.steps}`);
      console.log(`edits:     ${result.edits.length}`);
      for (const e of result.edits) {
        console.log(`           ${e.path}`);
      }
      console.log(`tokens:    in=${result.usage?.inputTokens ?? "?"}  out=${result.usage?.outputTokens ?? "?"}`);
      console.log(`final text: ${result.text.slice(0, 200)}${result.text.length > 200 ? "..." : ""}`);
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
            const contribsMatch = fm.match(/contributions:\s*\n([\s\S]*?)(\n[a-z]|---|$)/);
            console.log(`${prefix}${path.replace(testDir + "/", "")}  →  ${labelMatch?.[1] ?? "(no label)"}`);
            if (contribsMatch) {
              const lines = contribsMatch[1].split("\n").filter((l) => l.trim().startsWith("- "));
              console.log(`${prefix}  contributions: ${lines.length}`);
            }
          }
        }
      }
      walk(wikiDir);
      console.log("───────────────────────────────────────\n");

      // ── Lenient assertions ──────────────────────────────────────
      // We don't pin which subjects the LLM identifies — different
      // models will make different judgements. Just verify the loop
      // ran end-to-end and produced *some* mutations.
      expect(result.skipped).toBe(false);
      expect(result.steps).toBeGreaterThan(1);
      expect(result.edits.length).toBeGreaterThan(0);

      // At least one wiki file should exist with a populated
      // contributions array.
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

      const withContribs = wikiFiles.filter((p) =>
        readFileSync(p, "utf-8").includes("contributions:"),
      );
      expect(withContribs.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
