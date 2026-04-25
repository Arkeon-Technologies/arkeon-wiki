// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki ls` — list all running Arkeon instances.
 *
 * Reads the registry at ~/.arkeon-wiki/instances/. Stale entries
 * (pid no longer alive) are pruned by listInstances() on read.
 */

import type { Command } from "commander";

import { listInstances } from "../../lib/instances.js";
import { output } from "../../lib/output.js";

interface LsOptions {
  json?: boolean;
}

export function registerLsCommand(program: Command): void {
  program
    .command("ls")
    .description("List running Arkeon instances")
    .option("--json", "Output as JSON instead of a table")
    .action((options: LsOptions) => {
      const instances = listInstances();

      if (options.json) {
        output.result({ operation: "ls", instances });
        return;
      }

      if (instances.length === 0) {
        process.stdout.write("No running instances.\n");
        return;
      }

      const rows = instances.map((i) => ({
        NAME: i.name,
        PID: String(i.pid),
        URL: i.api_url,
        HOME: i.home,
        STARTED: i.started_at,
      }));
      printTable(rows);
    });
}

function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => (r[h] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  process.stdout.write(`${fmt(headers)}\n`);
  for (const row of rows) {
    process.stdout.write(`${fmt(headers.map((h) => row[h] ?? ""))}\n`);
  }
}
