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

import type { AgentConfig } from "../../src/server/agents/config.js";
import { loadAgentEnv } from "../../src/server/agents/env-loader.js";
import { buildAgentRole } from "../../src/server/agents/role-builder.js";
import { runAgent } from "../../src/server/agents/runtime.js";
import { ALL_TOOLS } from "../../src/server/agents/tools.js";
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

/**
 * Synthesize the same shape that loadAgentConfig() would produce —
 * but here we drive it from env vars instead of a YAML file, since
 * the demo's job is to prove the runtime works, not to test the
 * loader. (The loader has its own unit tests.)
 */
function demoConfig(): AgentConfig {
  return {
    defaults: {
      provider: PROVIDER,
      model: MODEL,
      base_url: process.env.AGENT_DEMO_BASE_URL,
    },
    // No `roles` override → uses the built-in `ingestor` template
    // verbatim. Add an entry like { roles: { ingestor: { instructions: ... } } }
    // here to demo operator-supplied focus tweaks.
  };
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

      // Wait for the watcher to index the source so the agent can
      // pass source_id through.
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

      // The whole point: build the role declaratively from config +
      // built-in template. No inline role construction.
      const role = buildAgentRole("ingestor", demoConfig());

      const result = await runAgent(
        role,
        { space, triggerPath: sourcePath, triggerEntityId: sourceId! },
        ALL_TOOLS,
      );

      // ── Report ──────────────────────────────────────────────────
      console.log("\n──────── REAL-LLM AGENT RESULT ────────");
      console.log(`provider:  ${PROVIDER}`);
      console.log(`model:     ${MODEL}`);
      console.log(`role:      ingestor (built-in)`);
      console.log(`steps:     ${result.steps}`);
      console.log(`edits:     ${result.edits.length}`);
      for (const e of result.edits) {
        console.log(`           ${e.path}`);
      }
      console.log(
        `tokens:    in=${result.usage?.inputTokens ?? "?"}  out=${result.usage?.outputTokens ?? "?"}`,
      );
      console.log(
        `final text: ${result.text.slice(0, 200)}${result.text.length > 200 ? "..." : ""}`,
      );
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
      console.log("───────────────────────────────────────\n");

      // ── Lenient assertions ──────────────────────────────────────
      expect(result.skipped).toBe(false);
      expect(result.steps).toBeGreaterThan(1);
      expect(result.edits.length).toBeGreaterThan(0);

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
});
