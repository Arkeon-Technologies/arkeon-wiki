// Manual rewriter smoke test — fires a real LLM via the bundled
// writer role against a fresh tiny corpus, then inspects the
// on-disk output and the relationships table.
//
// Not shipped: this is a developer-time smoke test for issue #134.
// Run from packages/arkeon:
//   OPENAI_API_KEY=… npx tsx scripts/manual-rewriter-test.ts

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

  const workdir = mkdtempSync(join(tmpdir(), "arkeon-manual-"));
  const dbPath = join(workdir, "arke.db");
  console.log("workdir:", workdir);

  try {
    await runMigrations({ dbPath });
    initDb(dbPath);

    const SPACE: Space = { name: "manual-test", watch_dir: workdir };
    const sql = createSql();
    await sql`INSERT INTO spaces(name, watch_dir) VALUES(${SPACE.name}, ${workdir})`;

    mkdirSync(join(workdir, "sources"), { recursive: true });
    mkdirSync(join(workdir, "wiki"), { recursive: true });

    writeFileSync(
      join(workdir, "sources/notes-on-attention.txt"),
      `Augustine on attention (paraphrase, Confessions X):
The mind is divided. We pursue many goods at once, never
committing. A heart pulled in directions cannot rest. This is
the structure of restlessness — the will scattered across
simultaneously-pursued ends. Healing requires consolidation
around one thing, the highest thing.`,
    );

    writeFileSync(
      join(workdir, "sources/modern-distraction-paper.txt"),
      `Excerpt from "Computational Attention and the Multitasking
Illusion" (Smith, 2024): Modern distraction is not a failure
of will but a structural feature of computational environments.
The OS-level multiplexing of attention IS the harm. Every
notification is a context switch with measurable cognitive
cost. The paper argues for "attentional fasting" as the
structural response: removing the substrate of distraction
rather than disciplining the user.`,
    );

    writeFileSync(
      join(workdir, "wiki/why-does-the-heart-stay-restless.html"),
      `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Why does the heart stay restless?</title>
  <meta name="label" content="Why does the heart stay restless?">
  <meta name="short_description" content="Augustine's restless heart, recast as a structural diagnosis of modern attention.">
</head>
<body>
  <h1>Why does the heart stay restless?</h1>
  <h2>Current answer</h2>
  <p>The restlessness is structural: a will scattered across
  simultaneous ends cannot consolidate around any of them.
  See <a href="../sources/notes-on-attention.txt">Augustine's
  paraphrase</a>.</p>
  <h2>Open threads</h2>
  <ul>
    <li><a href="modern-attention-as-os-multiplexing.html">how does
    OS-level multiplexing relate to scattered will?</a> — the
    structural argument from Smith may be a contemporary form of
    this older insight.</li>
  </ul>
</body>
</html>`,
    );

    await syncFile(SPACE, "sources/notes-on-attention.txt");
    await syncFile(SPACE, "sources/modern-distraction-paper.txt");
    await syncFile(SPACE, "wiki/why-does-the-heart-stay-restless.html");

    const redlinks = await sql`
      SELECT target_path, COUNT(*) AS demand FROM relationships r
      LEFT JOIN entities e ON e.space_name = r.space_name AND e.source_path = r.target_path
      WHERE r.space_name = ${SPACE.name} AND e.source_path IS NULL
        AND r.target_path NOT LIKE '/%'
      GROUP BY target_path
    `;
    console.log("Queued red links:", redlinks);

    async function fireRole(name: "writer" | "editor" | "proposer") {
      const role = buildAgentRole(name, {});
      banner(`FIRING ${name.toUpperCase()} (real OpenAI call)`);
      const start = Date.now();
      const result = await runAgent(role, { space: SPACE }, ALL_TOOLS);
      const ms = Date.now() - start;
      console.log(`${name} finished in ${(ms / 1000).toFixed(1)}s`);
      console.log("steps:", result.steps);
      console.log("text:", result.text);
      console.log(
        "edits:",
        result.edits.map((e) => ({ kind: e.kind, path: e.path })),
      );
      if (result.usage) console.log("usage:", result.usage);
      return result;
    }

    function auditFile(label: string, filePath: string) {
      if (!existsSync(filePath)) {
        console.log(`MISSING ON DISK: ${label}`);
        return;
      }
      const content = readFileSync(filePath, "utf-8");
      console.log(`\n── ${label} (${content.length} bytes) ──`);
      console.log(content);

      const spaceUrlHits = (content.match(/href="\/[^"]+"/g) ?? []).filter(
        (h) => !/^href="(https?:|mailto:|tel:)/.test(h),
      );
      if (spaceUrlHits.length > 0) {
        console.log("⚠ FOUND /-prefixed hrefs on disk:", spaceUrlHits);
      } else {
        console.log("✓ no /-prefixed hrefs on disk");
      }

      const relHrefs = (content.match(/href="[^"]+"/g) ?? []).filter(
        (h) => !/^href="(https?:|mailto:|tel:|#|\/)/.test(h),
      );
      console.log("relative hrefs found:", relHrefs);
    }

    const writerResult = await fireRole("writer");

    banner("ON-DISK INSPECTION (writer output)");
    for (const edit of writerResult.edits) {
      if (edit.kind !== "create") continue;
      auditFile(edit.path, join(workdir, edit.path));
    }

    // Editor pass — exercises edit_file with str_replace (asymmetric
    // rewrite) and insert_at_line.
    const editorResult = await fireRole("editor");
    banner("ON-DISK INSPECTION (after editor)");
    for (const edit of editorResult.edits) {
      auditFile(`${edit.kind}: ${edit.path}`, join(workdir, edit.path));
    }

    // Proposer pass — exercises nested plan-path layout
    // (wiki/_plans/sources/...) which depends on rewriter handling
    // deeper directories than v0's flatten workaround allowed.
    const proposerResult = await fireRole("proposer");
    banner("ON-DISK INSPECTION (proposer output)");
    for (const edit of proposerResult.edits) {
      if (edit.kind !== "create") continue;
      auditFile(edit.path, join(workdir, edit.path));
    }

    banner("RELATIONSHIPS AUDIT");
    const allRels = await sql`
      SELECT source_path, target_path, link_text FROM relationships
      WHERE space_name = ${SPACE.name}
      ORDER BY source_path, target_path
    `;
    for (const r of allRels) console.log(r);

    banner("RED LINKS AFTER");
    const rlAfter = await sql`
      SELECT target_path, COUNT(*) AS demand FROM relationships r
      LEFT JOIN entities e ON e.space_name = r.space_name AND e.source_path = r.target_path
      WHERE r.space_name = ${SPACE.name} AND e.source_path IS NULL
        AND r.target_path NOT LIKE '/%'
      GROUP BY target_path
    `;
    console.log(rlAfter);
  } finally {
    closeDb();
    console.log("\nKept workdir for inspection:", workdir);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
