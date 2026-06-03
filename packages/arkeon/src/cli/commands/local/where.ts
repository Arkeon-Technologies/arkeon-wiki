// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki where` — print which running instance owns the current
 * working directory, along with the CWD-relative path inside its
 * watched root.
 *
 * Mirrors `git rev-parse --show-toplevel` / `git rev-parse --show-prefix`
 * — a small introspection command so users can sanity-check what every
 * other api-CLI command (`query`, `tag`, ...) will end up talking to.
 *
 * Exit codes:
 *   0  CWD is under a registered watch root
 *   1  no instance owns CWD (no daemon running, or CWD is outside)
 */

import type { Command } from "commander";

import {
  findInstanceForCwd,
  relativeToWatchDir,
} from "../../lib/instance-resolve.js";
import { listInstances } from "../../lib/instances.js";
import { output } from "../../lib/output.js";

interface WhereOptions {
  json?: boolean;
}

export function registerWhereCommand(program: Command): void {
  program
    .command("where")
    .description(
      "Show which running instance owns the current directory (watch root + relative path)",
    )
    .option("--json", "Emit JSON instead of a human-readable summary")
    .action((options: WhereOptions) => {
      const cwd = process.cwd();
      const instances = listInstances();
      const owner = findInstanceForCwd(cwd, instances);

      if (!owner) {
        if (options.json) {
          output.error(
            new Error(
              `No running instance watches a directory containing ${cwd}.`,
            ),
            { operation: "where", code: "no_owner" },
          );
        } else {
          process.stderr.write(
            `No running instance watches a directory containing ${cwd}.\n` +
              `  - Run \`arkeon-wiki ls\` to see what's running.\n` +
              `  - Start one with \`arkeon-wiki up --watch-dir <path>\`.\n`,
          );
        }
        process.exit(1);
      }

      // findInstanceForCwd guarantees watch_dir is set, so this is non-null.
      const rel = relativeToWatchDir(cwd, owner) ?? "";

      if (options.json) {
        output.result({
          operation: "where",
          instance: owner.name,
          api_url: owner.api_url,
          watch_dir: owner.watch_dir,
          cwd,
          relative: rel,
        });
        return;
      }

      process.stdout.write(
        `instance:  ${owner.name}\n` +
          `api_url:   ${owner.api_url}\n` +
          `watch_dir: ${owner.watch_dir}\n` +
          `cwd:       ${cwd}\n` +
          `relative:  ${rel === "" ? "." : rel}\n`,
      );
    });
}
