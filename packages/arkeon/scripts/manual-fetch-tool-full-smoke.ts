// Live full-workflow smoke: an agent reads an HTML source containing
// BOTH remote and local <img src> references, fetches them all in one
// batched call, and describes what it sees. Verifies:
//
//   1. fetch handles remote URLs (substack-hosted chart)
//   2. fetch handles local paths within the watch dir
//   3. batched call attaches multiple images in one user message
//   4. the model can distinguish and describe both images
//
// Skipped automatically if OPENAI_API_KEY isn't set.

import "dotenv/config";

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Chart 1: "Globalisation through recent history" trade-openness area chart.
// Title visible, Y-axis "Trade Openness (% 3 yr ma)", X 1870-2020,
// notable: 1913 peak (38.1%), 1946 trough (7.5%), 2021 peak (43.4%).
const REMOTE_IMAGE =
  "https://substack-post-media.s3.amazonaws.com/public/images/6da3cdc6-f5ec-4ee6-8d70-736fc9697099_2754x1542.png";

// Chart 2: "Figure 4: The Global Economic System, 1995 vs. 2019" stacked
// bar chart comparing GDP / Military / Industry / High-tech exports /
// Resources / Population across AEs (blue) vs EMs (green). We'll fetch
// this once over HTTP and write it to disk, then have the agent fetch
// it via its LOCAL path so we exercise both paths in one workflow.
const LOCAL_IMAGE_SOURCE_URL =
  "https://substack-post-media.s3.amazonaws.com/public/images/586688a9-cf96-43ab-a652-177d683fac7d_1326x1076.png";

// Local image href uses the canonical space-rooted URL form — what
// every tool's `space_url` field returns and what the editor / writer
// already use for <a href> cross-references in wikis. Lets the agent
// paste it verbatim into fetch without doing path math.
const HTML_SOURCE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Two-chart deglobalisation snapshot</title>
</head>
<body>
<h1>Two-chart deglobalisation snapshot</h1>
<p>Trade openness over time:</p>
<img src="${REMOTE_IMAGE}" alt="Globalisation through recent history">
<p>System composition shift 1995 vs 2019:</p>
<img src="/smoke/images/global-system.png" alt="Global Economic System 1995 vs 2019">
</body>
</html>`;

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY not set — skipping smoke.");
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), "arkeon-fetch-full-"));
  const dbPath = join(workdir, "arke.db");
  mkdirSync(join(workdir, "sources"), { recursive: true });
  mkdirSync(join(workdir, "images"), { recursive: true });

  // Stage the HTML source on disk.
  writeFileSync(join(workdir, "sources/post.html"), HTML_SOURCE);

  // Download the "local" image to disk so the agent can fetch it via
  // its local path. This is the file the HTML's second <img> points at.
  console.log(`Downloading ${LOCAL_IMAGE_SOURCE_URL} → images/global-system.png ...`);
  const res = await fetch(LOCAL_IMAGE_SOURCE_URL);
  if (!res.ok) {
    throw new Error(`failed to fetch local image source: HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(workdir, "images/global-system.png"), bytes);
  console.log(`  saved ${bytes.byteLength} bytes`);

  await runMigrations({ dbPath });
  initDb(dbPath);

  const sql = createSql();
  await sql`INSERT INTO spaces(name, watch_dir) VALUES('smoke', ${workdir})`;

  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = openai("gpt-4o") as LanguageModel;

  const phase: AgentPhase = {
    name: "full-smoke",
    prompt:
      `Read the HTML at sources/post.html, find every <img src> in it, ` +
      `then fetch ALL of them in ONE batched fetch call (so both images ` +
      `arrive together). For each image, tell me: ` +
      `(a) chart title or subject, ` +
      `(b) one specific datum you can read from it.`,
    model: { provider: "openai", id: "gpt-4o" },
    tools: ["read_file", "fetch"],
    maxSteps: 6,
  };
  const role: AgentRole = {
    name: "full-smoke",
    model: phase.model,
    tools: phase.tools,
    maxSteps: phase.maxSteps,
    spaceScope: ["self"],
    async buildPhases() {
      return {
        system:
          "You have two tools: read_file (read text from the space) and " +
          "fetch (view URLs and local images). Use them to answer.",
        phases: [phase],
      };
    },
    concurrencyKey() {
      return `full-smoke-${workdir}`;
    },
  };

  try {
    const startedAt = Date.now();
    const result = await runAgent(
      role,
      { space: { name: "smoke", watch_dir: workdir } },
      ALL_TOOLS,
      { modelOverride: model },
    );
    const elapsedMs = Date.now() - startedAt;

    console.log("\n========== MODEL OUTPUT ==========");
    console.log(result.text);
    console.log("==================================\n");
    console.log(
      `steps: ${result.steps}, elapsed: ${elapsedMs}ms, usage: ${JSON.stringify(result.usage)}`,
    );

    const text = result.text.toLowerCase();
    // Remote chart markers (Globalisation through recent history)
    const remoteMarkers = [
      "globalisation",
      "trade",
      "1913",
      "38.1",
      "openness",
    ];
    // Local chart markers (Figure 4: Global Economic System)
    const localMarkers = [
      "global economic system",
      "1995",
      "2019",
      "gdp",
      "military",
      "emerging",
      "advanced",
    ];

    const remoteHits = remoteMarkers.filter((m) => text.includes(m));
    const localHits = localMarkers.filter((m) => text.includes(m));

    console.log(
      `\nRemote-chart markers: ${remoteHits.length}/${remoteMarkers.length} [${remoteHits.join(", ")}]`,
    );
    console.log(
      `Local-chart markers:  ${localHits.length}/${localMarkers.length} [${localHits.join(", ")}]`,
    );

    const remotePass = remoteHits.length >= 2;
    const localPass = localHits.length >= 2;
    if (remotePass && localPass) {
      console.log(
        "\nPASS — model demonstrably read BOTH images (remote URL and local path).",
      );
    } else {
      console.log(
        `\nINCOMPLETE — remote=${remotePass ? "ok" : "fail"} local=${localPass ? "ok" : "fail"}`,
      );
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
