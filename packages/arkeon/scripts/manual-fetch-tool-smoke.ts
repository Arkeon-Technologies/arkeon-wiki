// Live smoke test: spin up a tiny agent role with the `fetch` tool and
// see whether a real provider can use it to look at the chartbook
// "Globalisation through recent history" image.
//
// Skipped automatically if OPENAI_API_KEY isn't set. Not in the CI test
// suite — operator-driven verification before shipping.

import "dotenv/config";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../src/schema/migrate.js";
import { closeDb, createSql, initDb } from "../src/server/lib/sql.js";
import {
  runAgent,
  type AgentPhase,
  type AgentRole,
} from "../src/server/agents/runtime.js";
import { ALL_TOOLS } from "../src/server/agents/tools.js";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const IMAGE_URL =
  "https://substack-post-media.s3.amazonaws.com/public/images/6da3cdc6-f5ec-4ee6-8d70-736fc9697099_2754x1542.png";

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY not set — skipping smoke.");
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), "arkeon-smoke-fetch-"));
  const dbPath = join(workdir, "arke.db");
  mkdirSync(join(workdir, "wiki"), { recursive: true });

  await runMigrations({ dbPath });
  initDb(dbPath);

  const sql = createSql();
  await sql`INSERT INTO spaces(name, watch_dir) VALUES('smoke', ${workdir})`;

  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = openai("gpt-4o") as LanguageModel;

  const phase: AgentPhase = {
    name: "smoke",
    prompt:
      `Use fetch to view this image, then describe (1) the chart title, ` +
      `(2) the Y-axis label, (3) one specific data point you can read. ` +
      `Image URL: ${IMAGE_URL}`,
    model: { provider: "openai", id: "gpt-4o" },
    tools: ["fetch"],
    maxSteps: 5,
  };
  const role: AgentRole = {
    name: "smoke-fetch",
    model: phase.model,
    tools: phase.tools,
    maxSteps: phase.maxSteps,
    spaceScope: ["self"],
    async buildPhases() {
      return {
        system: "You have a fetch tool. Use it. Then answer.",
        phases: [phase],
      };
    },
    concurrencyKey() {
      return `smoke-${workdir}`;
    },
  };

  try {
    const result = await runAgent(
      role,
      { space: { name: "smoke", watch_dir: workdir } },
      ALL_TOOLS,
      { modelOverride: model },
    );

    console.log("\n========== MODEL OUTPUT ==========");
    console.log(result.text);
    console.log("==================================\n");
    console.log(`steps: ${result.steps}, usage: ${JSON.stringify(result.usage)}`);

    const text = result.text.toLowerCase();
    const markers = [
      "globalisation",
      "trade",
      "axis",
      "1913",
      "2021",
      "38.1",
      "43.4",
    ];
    const hits = markers.filter((m) => text.includes(m));
    console.log(`markers found: ${hits.length}/${markers.length} [${hits.join(", ")}]`);
    if (hits.length >= 3) {
      console.log("PASS — model demonstrably read the chart.");
    } else {
      console.log("UNCERTAIN — output doesn't show clear evidence of seeing the image.");
    }
  } finally {
    closeDb();
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
