// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki redlinks` — `GET /redlinks`. The work-to-be-written
 * queue: unresolved link targets ranked by demand.
 */

import type { Command } from "commander";

import { apiCall } from "../../lib/api-client.js";
import { isTty, printJson, printTable, truncate } from "../../lib/format.js";
import {
  addCommonOptions,
  readGlobals,
  transportOptions,
} from "./_globals.js";

interface RedlinksResponse {
  redlinks: Array<{
    target_path: string;
    demand: number;
    linked_from: string[];
  }>;
  total: number;
}

export function registerRedlinksCommand(program: Command): void {
  const cmd = addCommonOptions(
    program
      .command("redlinks")
      .description("List unresolved link targets, ranked by demand")
      .option("--folder <path>", "Restrict to redlinks under this folder prefix")
      .option("--limit <n>", "Result limit (max 200, default 50)")
      .option("--offset <n>", "Result offset"),
  );
  cmd.action(
    async (
      flags: { folder?: string; limit?: string; offset?: string },
      command: Command,
    ) => {
      const g = readGlobals(command);
      const result = await apiCall<RedlinksResponse>(
        "GET",
        "/redlinks",
        {
          query: {
            folder: flags.folder,
            limit: flags.limit,
            offset: flags.offset,
          },
        },
        transportOptions(g),
      );
      if (g.json || !isTty()) {
        printJson(result);
        return;
      }
      const rows = result.redlinks.map((r) => ({
        TARGET: r.target_path,
        DEMAND: String(r.demand),
        FROM: truncate(r.linked_from.join(", "), 60),
      }));
      printTable(rows);
      if (result.total > result.redlinks.length) {
        process.stdout.write(
          `\n(showing ${result.redlinks.length} of ${result.total})\n`,
        );
      }
    },
  );
}
