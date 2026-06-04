// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki where` — print which daemon the next substrate-API
 * command will target, and (when the answer is "an instance you have
 * registered") which watch root + relative path inside it.
 *
 * Mirrors `git rev-parse --show-toplevel` / `git rev-parse --show-prefix`
 * — a small introspection command so users can sanity-check what
 * `query`, `tag`, etc. will end up talking to. Resolves via the full
 * resolveTarget chain so the answer agrees with what other commands
 * see (including the in-container fallback and `default`-instance
 * fallback, which were invisible to `where` before).
 *
 * Exit codes:
 *   0  resolveTarget found a target (any source)
 *   1  resolveTarget threw (no daemon, --name miss, ...)
 */

import type { Command } from "commander";

import {
  relativeToWatchDir,
  resolveTarget,
} from "../../lib/instance-resolve.js";
import { output } from "../../lib/output.js";

interface WhereOptions {
  apiUrl?: string;
  name?: string;
  json?: boolean;
}

export function registerWhereCommand(program: Command): void {
  program
    .command("where")
    .description(
      "Show which daemon the next substrate-API command will target (resolution source + api_url)",
    )
    .option("--api-url <url>", "Probe with an explicit api_url override")
    .option("--name <name>", "Probe a specific named instance")
    .option("--json", "Emit JSON instead of a human-readable summary")
    .action((options: WhereOptions) => {
      const cwd = process.cwd();

      let target: ReturnType<typeof resolveTarget>;
      try {
        target = resolveTarget({ apiUrl: options.apiUrl, name: options.name });
      } catch (err) {
        const message = (err as Error).message;
        if (options.json) {
          output.error(new Error(message), { operation: "where", code: "unresolved" });
        } else {
          process.stderr.write(`${message}\n`);
        }
        process.exit(1);
      }

      const inst = target.instance;
      const rel = inst ? relativeToWatchDir(cwd, inst) : null;

      if (options.json) {
        output.result({
          operation: "where",
          source: target.source,
          api_url: target.api_url,
          instance: inst?.name ?? null,
          watch_dir: inst?.watch_dir ?? null,
          cwd,
          relative: rel,
        });
        return;
      }

      const lines: string[] = [
        `source:    ${target.source}`,
        `api_url:   ${target.api_url}`,
      ];
      if (inst) {
        lines.push(`instance:  ${inst.name}`);
        if (inst.watch_dir) {
          lines.push(`watch_dir: ${inst.watch_dir}`);
        }
      }
      lines.push(`cwd:       ${cwd}`);
      if (rel !== null) {
        lines.push(`relative:  ${rel === "" ? "." : rel}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}
