// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki backlinks <path>` — `GET /backlinks?path=...`.
 *
 * Works uniformly for resolved artifacts and unresolved redlink
 * targets; the response's `exists` field tells you which.
 */

import type { Command } from "commander";

import { apiCall } from "../../lib/api-client.js";
import { isTty, printJson, printTable, truncate } from "../../lib/format.js";
import {
  addCommonOptions,
  readGlobals,
  transportOptions,
} from "./_globals.js";

interface BacklinksResponse {
  path: string;
  exists: boolean;
  demand: number;
  backlinks: Array<{
    source_path: string;
    link_text: string | null;
    attrs: Record<string, string>;
    synced_at: string;
  }>;
}

export function registerBacklinksCommand(program: Command): void {
  const cmd = addCommonOptions(
    program
      .command("backlinks <path>")
      .description("Show inbound links pointing at an artifact (or redlink target)"),
  );
  cmd.action(async (path: string, _o: unknown, command: Command) => {
    const g = readGlobals(command);
    const result = await apiCall<BacklinksResponse>(
      "GET",
      "/backlinks",
      { query: { path } },
      transportOptions(g),
    );
    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    process.stdout.write(
      `target:  ${result.path}\n` +
        `exists:  ${result.exists}\n` +
        `demand:  ${result.demand}\n\n`,
    );
    const rows = result.backlinks.map((b) => ({
      SOURCE: b.source_path,
      TEXT: truncate(b.link_text, 30),
      QUOTE: truncate(b.attrs.quote, 50),
      SYNCED: b.synced_at,
    }));
    printTable(rows);
  });
}
