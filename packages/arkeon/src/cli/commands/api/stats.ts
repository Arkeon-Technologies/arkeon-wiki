// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki stats` — `GET /stats`. Corpus-level counts.
 */

import type { Command } from "commander";

import { apiCall } from "../../lib/api-client.js";
import { isTty, printJson, printKeyValue } from "../../lib/format.js";
import {
  addCommonOptions,
  readGlobals,
  transportOptions,
} from "./_globals.js";

interface StatsResponse {
  artifacts: { total: number; text: number; asset: number };
  links: number;
  redlinks: number;
  tag_keys: number;
}

export function registerStatsCommand(program: Command): void {
  const cmd = addCommonOptions(
    program
      .command("stats")
      .description("Show corpus-level counts (artifacts, links, redlinks, tag keys)"),
  );
  cmd.action(async (_o: unknown, command: Command) => {
    const g = readGlobals(command);
    const result = await apiCall<StatsResponse>(
      "GET",
      "/stats",
      {},
      transportOptions(g),
    );
    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    printKeyValue([
      ["artifacts.total", String(result.artifacts.total)],
      ["artifacts.text", String(result.artifacts.text)],
      ["artifacts.asset", String(result.artifacts.asset)],
      ["links", String(result.links)],
      ["redlinks", String(result.redlinks)],
      ["tag_keys", String(result.tag_keys)],
    ]);
  });
}
