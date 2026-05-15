// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

// Manual connector smoke test — fires the bundled connector role
// against a two-space corpus designed to have a clear cross-space
// thematic overlap, then inspects the result.
//
// Not shipped: developer-time smoke test for the connector PR.
// Run from packages/arkeon:
//   OPENAI_API_KEY=… npx tsx scripts/manual-connector-test.ts

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../src/schema/migrate.js";
import { closeDb, createSql, initDb } from "../src/server/lib/sql.js";
import { syncFile, type Space } from "../src/server/lib/sync.js";
import { ALL_TOOLS } from "../src/server/agents/tools.js";
import { runAgent } from "../src/server/agents/runtime.js";
import { buildAgentRole } from "../src/server/agents/role-builder.js";

function banner(s: string) {
  console.log("\n" + "─".repeat(60));
  console.log("▌ " + s);
  console.log("─".repeat(60));
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY required");
    process.exit(1);
  }

  // Two sibling watch_dirs — both "registered" via the spaces table,
  // so resolveAllowedSpaces("*") fans out across both.
  const rootDir = mkdtempSync(join(tmpdir(), "arkeon-connector-"));
  const augustineDir = join(rootDir, "augustine");
  const iarpaDir = join(rootDir, "iarpa");
  mkdirSync(augustineDir, { recursive: true });
  mkdirSync(iarpaDir, { recursive: true });
  const dbPath = join(rootDir, "arke.db");

  console.log("rootDir:", rootDir);

  try {
    await runMigrations({ dbPath });
    initDb(dbPath);

    const AUGUSTINE: Space = { name: "augustine", watch_dir: augustineDir };
    const IARPA: Space = { name: "iarpa", watch_dir: iarpaDir };
    const sql = createSql();
    await sql`INSERT INTO spaces(name, watch_dir) VALUES('augustine', ${augustineDir})`;
    await sql`INSERT INTO spaces(name, watch_dir) VALUES('iarpa', ${iarpaDir})`;

    // Augustine space: an article about restless will, plus its source.
    mkdirSync(join(augustineDir, "wiki"), { recursive: true });
    mkdirSync(join(augustineDir, "sources"), { recursive: true });
    writeFileSync(
      join(augustineDir, "sources/confessions-x.txt"),
      `Augustine, Confessions X (paraphrase): The heart is divided
because it pursues many goods at once. Restlessness is the
structural state of a will that cannot consolidate around a single
end. "Our heart is restless until it rests in Thee" names the
diagnosis as much as the cure — the cure being consolidation, not
mere stillness.`,
    );
    writeFileSync(
      join(augustineDir, "wiki/why-the-heart-is-restless.html"),
      `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Why is the heart restless?</title>
  <meta name="label" content="Why is the heart restless?">
  <meta name="short_description" content="Augustine's diagnosis of restlessness as the structural state of a divided will.">
</head>
<body>
  <h1>Why is the heart restless?</h1>
  <h2>Question</h2>
  <p>Restlessness feels like an emotional weather rather than a
  structural fact. Why does Augustine treat it as the latter?</p>
  <h2>Current answer</h2>
  <p>Augustine's diagnosis is that the heart is restless because the
  will is divided: it pursues many ends simultaneously and cannot
  consolidate around any one. Consolidation around "one thing, the
  highest thing" is named both the cure and the missing condition
  (see <a href="../sources/confessions-x.txt">Confessions X</a>).</p>
  <h2>Evidence</h2>
  <p>The source frames restlessness not as a mood but as the natural
  consequence of split desire — a structural rather than psychological
  fact (<a href="../sources/confessions-x.txt">Confessions X</a>).</p>
  <h2>Open threads</h2>
  <ul>
    <li>What does consolidation actually look like in practice?</li>
  </ul>
</body>
</html>`,
    );

    // IARPA space: an article on attention/distraction with a similar
    // structural diagnosis from a totally different vocabulary.
    mkdirSync(join(iarpaDir, "wiki"), { recursive: true });
    mkdirSync(join(iarpaDir, "sources"), { recursive: true });
    writeFileSync(
      join(iarpaDir, "sources/multiplexing-paper.txt"),
      `Smith (2024), "Computational Attention and the Multitasking
Illusion": Modern distraction is not a failure of will but a
structural feature of computational environments. The OS-level
multiplexing of attention IS the harm. Every notification is a
context switch with measurable cognitive cost. The paper argues for
"attentional fasting" as the structural response: remove the
substrate of distraction rather than discipline the user.`,
    );
    writeFileSync(
      join(iarpaDir, "wiki/why-multiplexing-harms-attention.html"),
      `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Why does multiplexing harm attention?</title>
  <meta name="label" content="Why does multiplexing harm attention?">
  <meta name="short_description" content="Context-switching cost as a structural argument for why divided attention cannot rest.">
</head>
<body>
  <h1>Why does multiplexing harm attention?</h1>
  <h2>Question</h2>
  <p>Distraction is usually framed as a personal failing. Is it
  actually a structural property of the system the mind runs in?</p>
  <h2>Current answer</h2>
  <p>Smith's argument is that distraction is a property of the
  scheduling environment, not the operator. The OS-level multiplexing
  of attention imposes a measurable cost per context switch; rest is
  unreachable because the substrate keeps splitting attention against
  the user's will (<a href="../sources/multiplexing-paper.txt">Smith
  2024</a>).</p>
  <h2>Evidence</h2>
  <p>The paper makes the structural claim explicit: "The OS-level
  multiplexing of attention IS the harm"
  (<a href="../sources/multiplexing-paper.txt">Smith 2024</a>). The
  proposed remedy — attentional fasting — is architectural rather
  than disciplinary.</p>
  <h2>Open threads</h2>
  <ul>
    <li>How does this map onto older accounts of divided desire?</li>
  </ul>
</body>
</html>`,
    );

    // Sync everything so the relationship graph + tag queue exist.
    await syncFile(AUGUSTINE, "sources/confessions-x.txt");
    await syncFile(AUGUSTINE, "wiki/why-the-heart-is-restless.html");
    await syncFile(IARPA, "sources/multiplexing-paper.txt");
    await syncFile(IARPA, "wiki/why-multiplexing-harms-attention.html");

    // Confirm cross-space inbound is empty before the connector runs.
    const sql2 = createSql();
    const inboundBefore = await sql2`
      SELECT space_name, source_path, target_path FROM relationships
      WHERE target_path LIKE '/%'
    `;
    console.log("Cross-space relationships BEFORE connector run:", inboundBefore);

    // Fire the connector against the augustine space. spaces: ["*"]
    // → multi-space, but writes target augustine.
    const role = buildAgentRole("connector", {});
    banner("FIRING CONNECTOR (real OpenAI call, multi-space)");
    const start = Date.now();
    const result = await runAgent(role, { space: AUGUSTINE }, ALL_TOOLS);
    const ms = Date.now() - start;
    console.log(`Connector finished in ${(ms / 1000).toFixed(1)}s`);
    console.log("steps:", result.steps);
    console.log("text:", result.text);
    console.log(
      "edits:",
      result.edits.map((e) => ({ kind: e.kind, path: e.path })),
    );
    if (result.usage) console.log("usage:", result.usage);

    banner("ON-DISK INSPECTION (augustine space)");
    for (const edit of result.edits) {
      const filePath = join(augustineDir, edit.path);
      if (!existsSync(filePath)) {
        console.log(`MISSING ON DISK: ${edit.path}`);
        continue;
      }
      const content = readFileSync(filePath, "utf-8");
      console.log(`\n── ${edit.kind}: ${edit.path} (${content.length} bytes) ──`);
      console.log(content);

      // Audit cross-space hrefs: did the connector reference IARPA's
      // article via a clean cross-space link? After the rewriter
      // resolves it, on-disk should have a filesystem-relative path
      // ending in iarpa/wiki/...
      const crossSpaceHits = (content.match(/href="[^"]*iarpa\/[^"]*"/g) ?? []);
      console.log("cross-space hrefs found:", crossSpaceHits);

      const spaceUrlLeak = (content.match(/href="\/[^"]+"/g) ?? []).filter(
        (h) => !/^href="(https?:|mailto:|tel:)/.test(h),
      );
      if (spaceUrlLeak.length > 0) {
        console.log("⚠ /-prefixed hrefs leaked on disk:", spaceUrlLeak);
      } else {
        console.log("✓ no /-prefixed hrefs leaked on disk");
      }
    }

    banner("RELATIONSHIPS AFTER");
    const allRels = await sql2`
      SELECT space_name, source_path, target_path FROM relationships
      ORDER BY space_name, source_path, target_path
    `;
    for (const r of allRels) console.log(r);

    banner("CROSS-SPACE EDGES");
    const crossEdges = await sql2`
      SELECT space_name, source_path, target_path FROM relationships
      WHERE target_path LIKE '/%'
    `;
    if (crossEdges.length === 0) {
      console.log("⚠ No cross-space edges created.");
    } else {
      for (const r of crossEdges) console.log(r);
    }

    banner("CONNECTOR TAG STATE");
    const tags = await sql2`
      SELECT space_name, source_path, tags FROM entities
      WHERE tags LIKE '%connector.processed_hash%'
    `;
    for (const r of tags) console.log(r);
  } finally {
    closeDb();
    console.log("\nKept rootDir for inspection:", rootDir);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
