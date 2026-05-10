// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-LLM end-to-end demo for the cron-driven writer.
 *
 * Drives `runAgent` against an actual provider (OpenAI by default)
 * using the bundled `writer` role at agents/templates/writer.yaml.
 * Drops a few source files into a watched space, then invokes the
 * writer in cron mode (no triggerPath) and asserts:
 *
 *   1. The writer produces at least one article under wiki/article/
 *   2. The article body is non-trivial and cites at least one source
 *
 * The cron timer itself is mechanically tested in test/e2e/scheduler-
 * cron.test.ts; this manual test validates that the writer's prompt +
 * tool-use loop actually writes something useful when given real
 * unprocessed sources.
 *
 * Skipped automatically when no API key is set. Invoke explicitly:
 *
 *   npm run test:manual -w packages/arkeon
 *
 * Drop your key into ~/.arkeon-wiki/.env (auto-loaded), or set
 * OPENAI_API_KEY / ANTHROPIC_API_KEY in the shell. Override the
 * provider/model with AGENT_DEMO_PROVIDER, AGENT_DEMO_MODEL.
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

// Load .env in precedence order: shell > repo .env > ~/.arkeon-wiki/.env.
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

  // agents.yaml: provider/model only. We invoke the writer via
  // runAgent directly in the tests below, so we don't need a fast
  // cron — the bundled template's default cron stays unused.
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

  // Plant a few sources before the test runs. The watcher syncs them
  // into entities so list_entities surfaces them as "recent
  // unprocessed sources" (inbound_max=0).
  writeFileSync(
    join(testDir, "sources/shannon-1948.md"),
    [
      "# A Mathematical Theory of Communication",
      "",
      "Claude Shannon's 1948 paper introduced the foundational ideas of",
      "information theory. He defined information as the resolution of",
      "uncertainty: a message's information content depends not on what it",
      "says but on how surprising it is given the receiver's prior beliefs.",
      "",
      "The paper's core technical contribution was the noisy-channel",
      "coding theorem: for any channel, there exists a maximum rate at",
      "which information can be transmitted with arbitrarily low error.",
      "Shannon called this the channel capacity, and proved that codes",
      "exist that approach it.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(testDir, "sources/shannon-bell-labs.md"),
    [
      "# Shannon at Bell Labs",
      "",
      "Claude Shannon spent the bulk of his career at Bell Telephone",
      "Laboratories in Murray Hill, New Jersey. He arrived in 1941 and",
      "stayed for fifteen years before joining the MIT faculty.",
      "",
      "Bell Labs in the 1940s was a remarkable institution: a corporate",
      "research lab with the freedom and resources of a university but the",
      "engineering focus of an industrial concern. Shannon's information-",
      "theoretic work emerged from the Labs' practical problems with",
      "long-distance telephone signal degradation.",
      "",
    ].join("\n"),
  );

  // Wait briefly for the watcher to sync them.
  const sql = createSql();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await sql`
      SELECT COUNT(*) AS n FROM entities
      WHERE space_id = ${space.id} AND type = 'file'
    `;
    if ((rows[0] as { n: number }).n >= 2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
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

function listWikiFiles(): string[] {
  const wikiDir = join(testDir, "wiki");
  const out: string[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) out.push(p);
    }
  }
  walk(wikiDir);
  return out;
}

describe.skipIf(!HAS_KEY)("real-LLM writer agent (cron mode)", () => {
  it(
    "writes at least one article from recent unprocessed sources",
    async () => {
      const config = loadAgentConfig({ spaceDir: testDir });
      const role = buildAgentRole("writer", config);

      // Cron-mode invocation: no triggerPath, no triggerEntityId.
      // The role's prompt tells it to query state and pick its own
      // work. Idempotency is skipped at the runtime layer.
      const result = await runAgent(
        role,
        { space, meta: {} },
        ALL_TOOLS,
        {},
      );

      console.log("\n──────── REAL-LLM WRITER RESULT (cron mode) ────────");
      console.log(`provider:  ${PROVIDER}`);
      console.log(`model:     ${MODEL}`);
      console.log(`role:      writer (bundled template)`);
      console.log(`steps:     ${result.steps}`);
      console.log(`edits:     ${result.edits.length}`);
      console.log(`tokens:    ${result.usage?.totalTokens ?? "?"}`);
      console.log(`text tail: ${result.text.slice(0, 240)}`);
      console.log("\nFiles on disk under wiki/:");
      const files = listWikiFiles();
      for (const p of files) {
        const c = readFileSync(p, "utf-8");
        const labelMatch = c.match(/^label:\s*(.+)$/m);
        console.log(
          `  ${p.replace(testDir + "/", "")}  →  ${labelMatch?.[1]?.trim() ?? "(no label)"}  (${c.length} chars)`,
        );
      }
      console.log("─────────────────────────────────────────────────────\n");

      // The writer should make at least one edit.
      expect(result.edits.length).toBeGreaterThan(0);

      // At least one article file should exist on disk.
      const articleFiles = files.filter((p) =>
        p.includes("/wiki/article/") || p.includes("/wiki/"),
      );
      expect(articleFiles.length).toBeGreaterThan(0);

      // At least one article should have a non-trivial body and cite
      // one of the source files we planted (provenance backlink).
      const bodies = articleFiles.map((p) => readFileSync(p, "utf-8"));
      const withSourceCitation = bodies.filter(
        (s) =>
          s.includes("shannon-1948") || s.includes("shannon-bell-labs"),
      );
      expect(withSourceCitation.length).toBeGreaterThan(0);

      // Each cited body should have meaningful content past the
      // frontmatter. (Splits on `---` give [pre, frontmatter, body]
      // for a properly-fenced file.)
      const meaningful = withSourceCitation.filter((s) => {
        const parts = s.split(/^---$/m);
        return parts.length >= 3 && parts[2].trim().length > 100;
      });
      expect(meaningful.length).toBeGreaterThan(0);
    },
    240_000,
  );
});
