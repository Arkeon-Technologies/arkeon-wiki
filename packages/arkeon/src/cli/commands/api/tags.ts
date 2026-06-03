// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki tags <path>` — `GET /tags?path=...`.
 */

import type { Command } from "commander";

import { apiCall } from "../../lib/api-client.js";
import { isTty, printJson, printKeyValue } from "../../lib/format.js";
import {
  addCommonOptions,
  readGlobals,
  transportOptions,
} from "./_globals.js";

interface TagsResponse {
  path: string;
  tags: Record<string, string>;
}

export function registerTagsCommand(program: Command): void {
  const cmd = addCommonOptions(
    program
      .command("tags <path>")
      .description("Show all tags on an artifact"),
  );
  cmd.action(async (path: string, _o: unknown, command: Command) => {
    const g = readGlobals(command);
    const result = await apiCall<TagsResponse>(
      "GET",
      "/tags",
      { query: { path } },
      transportOptions(g),
    );
    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    const entries = Object.entries(result.tags).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    printKeyValue(entries.map(([k, v]) => [k, v || "(empty)"]));
  });
}
