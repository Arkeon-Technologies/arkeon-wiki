// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Programmatic smoke for the consolidator role.
 *
 * Points at a wiki corpus, reconciles it into a fresh SQLite database,
 * then runs the consolidator on a chosen subject wiki. Streams the
 * structured agent trace as the run progresses and prints a summary
 * of edits and any deletions.
 *
 * This is a development tool — not part of the test suite. It hits
 * the real OpenAI API and mutates the corpus on disk. Always point it
 * at a copy of the corpus you don't mind diffing against.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... \
 *   tsx scripts/smoke-consolidator.ts \
 *     --corpus /Users/chim/Working/arkeon/smoke-augustine-test \
 *     --wiki wiki/concept/righteousness.md
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { runMigrations } from "../src/schema/index.js";
import { closeDb, createSql } from "../src/server/lib/sql.js";
import { generateUlid } from "../src/server/lib/ids.js";
import { syncDirectory, type Space } from "../src/server/lib/sync.js";
import { walkEligibleFiles } from "../src/server/lib/fs-watcher.js";
import { drain as drainEmbeddings } from "../src/server/lib/embedder/worker.js";

import { loadAgentConfig } from "../src/server/agents/config.js";
import { buildAgentRole } from "../src/server/agents/role-builder.js";
import { runAgent } from "../src/server/agents/runtime.js";
import { ALL_TOOLS } from "../src/server/agents/tools.js";

interface CliArgs {
  corpus: string;
  wikis: string[];
  arkeonHome?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: { corpus?: string; wikis: string[]; arkeonHome?: string } = {
    wikis: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus") args.corpus = argv[++i];
    else if (a === "--wiki") args.wikis.push(argv[++i]);
    else if (a === "--arkeon-home") args.arkeonHome = argv[++i];
  }
  if (!args.corpus) {
    throw new Error(
      "Required: --corpus <path> (the wiki corpus to point at; usually a copy)",
    );
  }
  if (args.wikis.length === 0) {
    throw new Error(
      "Required: --wiki <relative-path> (one or more; relative to corpus)",
    );
  }
  return { corpus: args.corpus, wikis: args.wikis, arkeonHome: args.arkeonHome };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Spin up an isolated arkeon home so this run doesn't touch the
  // user's real state. Drop a fresh database in there and run
  // migrations from scratch — the corpus's existing .arkeon/state.json
  // is irrelevant; we resync from disk.
  const arkeonHome =
    args.arkeonHome ?? join(tmpdir(), `arkeon-smoke-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(arkeonHome, "data"), { recursive: true });
  process.env.ARKEON_WIKI_HOME = arkeonHome;
  process.env.DATABASE_PATH = join(arkeonHome, "data", "arke.db");

  // Tracing on, file inside the isolated home so it's easy to find.
  process.env.ARKEON_WIKI_AGENT_TRACE = "1";
  const tracePath = join(arkeonHome, "agent-trace.jsonl");
  process.env.ARKEON_WIKI_AGENT_TRACE_FILE = tracePath;

  // The consolidator's discovery is vector-search-led, so we need
  // embeddings on. The model is large (309 MB) but expected to be
  // cached at the user-global ARKEON_WIKI_MODELS_DIR (defaults to
  // ~/.arkeon-wiki/models/). If it isn't, the first run downloads it
  // — that's a one-time cost.
  process.env.ARKEON_WIKI_EMBEDDINGS = "1";
  process.env.ARKEON_WIKI_CHUNKING = "1";
  // Reuse the user's existing model cache rather than letting the
  // bundled embedder write a fresh 316 MB into the smoke's isolated
  // home. The cache path is shared across all daemons and smoke runs.
  if (!process.env.ARKEON_WIKI_MODELS_DIR) {
    const userModels = join(process.env.HOME ?? "", ".arkeon-wiki", "models");
    if (existsSync(userModels)) {
      process.env.ARKEON_WIKI_MODELS_DIR = userModels;
    }
  }

  console.log(`[smoke] arkeon home: ${arkeonHome}`);
  console.log(`[smoke] corpus:      ${args.corpus}`);
  console.log(`[smoke] trace file:  ${tracePath}`);

  await runMigrations({ dbPath: process.env.DATABASE_PATH });

  // Insert the space.
  const space: Space = {
    id: generateUlid(),
    name: "smoke-augustine",
    watch_dir: args.corpus,
  };
  const sql = createSql();
  await sql`
    INSERT INTO spaces (id, name, watch_dir)
    VALUES (${space.id}, ${space.name}, ${space.watch_dir})
  `;

  // Reconcile the corpus from disk.
  console.log(`[smoke] reconciling corpus...`);
  const files = walkEligibleFiles(space.watch_dir);
  const summary = await syncDirectory(space, files);
  console.log(
    `[smoke] reconciled: created=${summary.created} updated=${summary.updated} ` +
      `unchanged=${summary.unchanged} removed=${summary.removed}`,
  );

  // Drain the embedding queue synchronously before the consolidator
  // runs — `syncDirectory` enqueues every wiki, but in production a
  // background worker drains. For a smoke we drain inline so vector
  // search has a fully populated chunk_vectors table by the time the
  // consolidator's gather phase calls it. First call constructs the
  // embedder (warms the model from disk cache) which is where the
  // ~10s of one-time cost lands.
  console.log(`[smoke] embedding chunks (warming model + draining queue)...`);
  const embedStart = Date.now();
  await drainEmbeddings();
  console.log(`[smoke] embeddings drained in ${(Date.now() - embedStart) / 1000}s`);

  // Build the consolidator role.
  const config = loadAgentConfig({ spaceDir: space.watch_dir });
  const role = buildAgentRole("consolidator", config);
  console.log(`[smoke] consolidator built: model=${role.model.id}`);

  // Run the consolidator on each requested wiki.
  for (const wikiPath of args.wikis) {
    console.log(`\n[smoke] === consolidating ${wikiPath} ===`);

    const beforeBody = readFileSync(join(space.watch_dir, wikiPath), "utf-8");

    // Find the entity id for this wiki path.
    const rows = (await sql`
      SELECT id FROM entities
      WHERE space_id = ${space.id} AND source_path = ${wikiPath}
    `) as { id: string }[];
    if (rows.length === 0) {
      console.error(`[smoke] no entity for ${wikiPath} — skipping`);
      continue;
    }
    const entityId = rows[0].id;

    // Read the entity's source_hash so we mirror what the scheduler
    // would inject via input.meta.
    const hashRow = (await sql`
      SELECT source_hash FROM entities WHERE id = ${entityId}
    `) as { source_hash: string }[];

    const start = Date.now();
    const result = await runAgent(
      role,
      {
        space,
        triggerPath: wikiPath,
        triggerEntityId: entityId,
        meta: { source_hash: hashRow[0]?.source_hash ?? null },
      },
      ALL_TOOLS,
      {},
    );
    const durationMs = Date.now() - start;

    console.log(`[smoke] run finished in ${(durationMs / 1000).toFixed(1)}s`);
    console.log(
      `[smoke]   skipped=${result.skipped} steps=${result.steps} edits=${result.edits.length}` +
        (result.usage
          ? ` tokens(in/out)=${result.usage.inputTokens}/${result.usage.outputTokens}`
          : ""),
    );

    if (result.edits.length > 0) {
      console.log(`[smoke]   edits:`);
      for (const e of result.edits) {
        if (e.kind === "delete") {
          console.log(`[smoke]     DELETE ${e.path}`);
        } else {
          console.log(
            `[smoke]     ${e.kind.toUpperCase()} ${e.path} (${e.sync.action})`,
          );
        }
      }
    }

    // Diff before/after for the subject wiki specifically (if it
    // wasn't deleted). Other-wiki edits are visible via the trace.
    const subjectStillExists = existsSync(join(space.watch_dir, wikiPath));
    if (subjectStillExists) {
      const afterBody = readFileSync(join(space.watch_dir, wikiPath), "utf-8");
      const sameSize = afterBody.length === beforeBody.length;
      console.log(
        `[smoke]   subject body: ${beforeBody.length} → ${afterBody.length} chars` +
          (sameSize ? " (unchanged size; may still differ)" : ""),
      );
    } else {
      console.log(`[smoke]   subject body: DELETED`);
    }

    console.log(`[smoke]   final assistant message:`);
    const text = result.text.trim();
    const lines = text.split("\n").slice(0, 30);
    for (const line of lines) console.log(`[smoke]     ${line}`);
    if (text.split("\n").length > 30) {
      console.log(`[smoke]     ... (truncated)`);
    }
  }

  console.log(`\n[smoke] trace events: ${tracePath}`);
  console.log(`[smoke] arkeon home (db, logs): ${arkeonHome}`);
  console.log(`[smoke] tail with: jq -c < ${tracePath}`);

  closeDb();
}

main().catch((err) => {
  console.error(`[smoke] FAILED: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
