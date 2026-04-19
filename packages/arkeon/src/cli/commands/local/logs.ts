// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon logs [prefixes...]` — tail ~/.arkeon-wiki/arkeon.log with an
 * optional prefix filter ([meili], [api], [retention], [queue], etc.).
 *
 * Prefixes are the [foo] tags the daemon writes itself plus anything
 * Meilisearch prints prefixed as `[meili]`. Passing `arkeon logs meili`
 * shows only Meilisearch-originating lines.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";

import { isProcessAlive, logfile, readPidfile } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface LogsOptions {
  follow?: boolean;
  tail?: string;
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs [prefixes...]")
    .description(
      "Tail the arkeon daemon log. Optional positional prefixes (e.g. `arkeon logs meili`) filter lines by [prefix] tag.",
    )
    .option("--no-follow", "Print the tail and exit instead of streaming")
    .option("-n, --tail <lines>", "How many lines from the end to show", "100")
    .action(async (prefixes: string[], opts: LogsOptions) => {
      try {
        const path = logfile();
        const pid = readPidfile();
        const running = pid !== null && isProcessAlive(pid);

        if (!running) {
          output.warn("[arkeon] stack is not running — showing any existing log contents.");
        }

        if (!existsSync(path)) {
          output.warn(`[arkeon] no log file at ${path}. Start the stack with \`arkeon up\`.`);
          return;
        }

        const tailLines = Number(opts.tail ?? "100") || 100;
        const followRequested = opts.follow !== false;

        // Windows: no tail -f — fall back to static tail.
        if (followRequested && platform() !== "win32") {
          await streamTail(path, tailLines, prefixes);
        } else {
          printTail(path, tailLines, prefixes);
        }
      } catch (error) {
        output.error(error, { operation: "logs" });
        process.exitCode = 1;
      }
    });
}

/**
 * Stream the log via `tail -n <N> -f <path>`, piping through a filter
 * if the user supplied prefix arguments. We shell out to tail rather
 * than reimplement the "block until more data" loop — it's been tuned
 * in the BSD/GNU coreutils for decades.
 */
async function streamTail(path: string, lines: number, prefixes: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tail", ["-n", String(lines), "-f", path], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    const shouldFilter = prefixes.length > 0;

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let newlineIdx = buf.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);
        if (!shouldFilter || matchesAnyPrefix(line, prefixes)) {
          process.stdout.write(`${line}\n`);
        }
        newlineIdx = buf.indexOf("\n");
      }
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `tail failed: ${err.message}. Install coreutils or use --no-follow for a static dump.`,
        ),
      );
    });
    child.on("exit", () => resolve());

    // SIGINT from the user → kill tail, exit cleanly.
    process.on("SIGINT", () => {
      child.kill("SIGTERM");
      process.exit(0);
    });
  });
}

function printTail(path: string, lines: number, prefixes: string[]): void {
  const text = readFileSync(path, "utf-8");
  const all = text.split("\n");
  const start = Math.max(0, all.length - lines);
  const tail = all.slice(start);
  const filtered =
    prefixes.length > 0 ? tail.filter((line) => matchesAnyPrefix(line, prefixes)) : tail;
  process.stdout.write(filtered.join("\n"));
  if (filtered.length > 0 && !filtered[filtered.length - 1].endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function matchesAnyPrefix(line: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    // Match `[prefix] …` at the start of the trimmed line. We allow
    // leading whitespace because embedded-postgres sometimes indents
    // its notices.
    if (line.trimStart().startsWith(`[${prefix}]`)) return true;
  }
  return false;
}
