// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon reset` — wipe local state so the next `arkeon start` begins
 * from a fresh, empty cluster.
 *
 * By default, `reset` removes the data directories (~/.arkeon-wiki/data/)
 * but leaves secrets and the Meilisearch binary intact — that way the
 * user keeps their admin API key and doesn't re-download the 100MB
 * binary on the next start.
 *
 * `--hard` wipes the whole ~/.arkeon-wiki/ directory including secrets and
 * the downloaded binary. Use when you want truly from-zero state.
 *
 * Refuses to run if arkeon is currently running (we'd be deleting files
 * out from under a live Postgres cluster).
 */

import type { Command } from "commander";
import { existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  arkeonDir,
  dataDir,
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";

interface ResetOptions {
  hard?: boolean;
  force?: boolean;
}

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Wipe local Arkeon state (data directories; --hard wipes secrets + binaries too)")
    .option("--hard", "Also remove secrets and the downloaded Meilisearch binary")
    .option("-f, --force", "Skip the confirmation prompt")
    .action(async (options: ResetOptions) => {
      const runningPid = readPidfile();
      if (runningPid && isProcessAlive(runningPid)) {
        console.error(
          `arkeon is running (pid ${runningPid}). Stop it first with \`arkeon stop\`.`,
        );
        process.exit(1);
      }
      // If there's a stale pidfile, clean it up before wiping.
      if (runningPid) removePidfile();

      const targets = options.hard ? [arkeonDir()] : [dataDir()];
      const existing = targets.filter((t) => existsSync(t));
      if (existing.length === 0) {
        console.log("Nothing to remove.");
        return;
      }

      if (!options.force) {
        console.log("About to delete:");
        for (const t of existing) console.log(`  ${t}`);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
          console.log("Aborted.");
          process.exit(0);
        }
      }

      for (const target of existing) {
        rmSync(target, { recursive: true, force: true });
        console.log(`Removed ${target}`);
      }
      console.log("Done.");
    });
}
