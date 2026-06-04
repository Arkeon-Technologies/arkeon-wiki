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
  tag_keys_top: Array<{ key: string; n: number }>;
}

interface StatsOptions {
  tagKeysTop?: string;
}

export function registerStatsCommand(program: Command): void {
  const cmd = addCommonOptions(
    program
      .command("stats")
      .description("Show corpus-level counts (artifacts, links, redlinks, tag keys)")
      .option(
        "--tag-keys-top <n>",
        "Number of top tag keys to include (default 10, max 100)",
      ),
  );
  cmd.action(async (options: StatsOptions, command: Command) => {
    const g = readGlobals(command);
    const result = await apiCall<StatsResponse>(
      "GET",
      "/stats",
      { query: { tag_keys_top: options.tagKeysTop ?? null } },
      transportOptions(g),
    );
    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    const rows: Array<[string, string]> = [
      ["artifacts.total", String(result.artifacts.total)],
      ["artifacts.text", String(result.artifacts.text)],
      ["artifacts.asset", String(result.artifacts.asset)],
      ["links", String(result.links)],
      ["redlinks", String(result.redlinks)],
      ["tag_keys", String(result.tag_keys)],
    ];
    for (const { key, n } of result.tag_keys_top) {
      rows.push([`tag_keys_top.${key}`, String(n)]);
    }
    printKeyValue(rows);
  });
}
