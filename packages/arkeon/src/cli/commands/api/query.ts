// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki query` — `POST /query`. The workhorse: filter the
 * artifact index by folder prefix, kind, tag presence/absence, and
 * FTS5 match.
 */

import type { Command } from "commander";

import { apiCall } from "../../lib/api-client.js";
import { isTty, printJson, printTable, truncate } from "../../lib/format.js";
import {
  addCommonOptions,
  readGlobals,
  transportOptions,
} from "./_globals.js";

interface QueryFlags {
  folder?: string;
  kinds?: string[];
  hasTag?: string[];
  notTag?: string[];
  hasProperty?: string[];
  notProperty?: string[];
  text?: string;
  orderBy?: string;
  order?: string;
  limit?: string;
  offset?: string;
}

interface QueryResponse {
  artifacts: Array<{
    path: string;
    kind: string;
    label: string | null;
    updated_at: string;
  }>;
  total: number;
}

const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

export function registerQueryCommand(program: Command): void {
  const cmd = addCommonOptions(
    program
      .command("query")
      .description("List artifacts matching the given filters")
      .option("--folder <path>", "Restrict to artifacts under this folder prefix")
      .option(
        "--kinds <kinds>",
        "Restrict by artifact kind (text or asset, repeatable or comma-separated)",
        collect,
        [] as string[],
      )
      .option(
        "--has-tag <key[:value]>",
        "Require this tag (repeatable)",
        collect,
        [] as string[],
      )
      .option(
        "--not-tag <key[:value]>",
        "Exclude artifacts with this tag (repeatable)",
        collect,
        [] as string[],
      )
      .option(
        "--has-property <key[:value]>",
        "Require this properties.<key> (repeatable)",
        collect,
        [] as string[],
      )
      .option(
        "--not-property <key[:value]>",
        "Exclude artifacts with this properties.<key> (repeatable)",
        collect,
        [] as string[],
      )
      .option("--text <query>", "FTS5 match query against artifact body text")
      .option(
        "--order-by <column>",
        "Sort column: updated_at | created_at | path",
      )
      .option("--order <dir>", "Sort direction: asc | desc")
      .option("--limit <n>", "Result limit (max 200, default 50)")
      .option("--offset <n>", "Result offset"),
  );

  cmd.action(async (flags: QueryFlags, command: Command) => {
    const g = readGlobals(command);
    const body = {
      folder: flags.folder,
      kinds: flags.kinds && flags.kinds.length > 0 ? flags.kinds : undefined,
      has_tag: flags.hasTag && flags.hasTag.length > 0 ? flags.hasTag : undefined,
      not_tag: flags.notTag && flags.notTag.length > 0 ? flags.notTag : undefined,
      has_property:
        flags.hasProperty && flags.hasProperty.length > 0
          ? flags.hasProperty
          : undefined,
      not_property:
        flags.notProperty && flags.notProperty.length > 0
          ? flags.notProperty
          : undefined,
      text: flags.text,
      order_by: flags.orderBy,
      order: flags.order,
      limit: flags.limit != null ? Number(flags.limit) : undefined,
      offset: flags.offset != null ? Number(flags.offset) : undefined,
    };
    const result = await apiCall<QueryResponse>(
      "POST",
      "/query",
      { body },
      transportOptions(g),
    );

    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    const rows = result.artifacts.map((a) => ({
      PATH: a.path,
      KIND: a.kind,
      LABEL: truncate(a.label, 40),
      UPDATED: a.updated_at,
    }));
    printTable(rows);
    if (result.total > result.artifacts.length) {
      process.stdout.write(
        `\n(showing ${result.artifacts.length} of ${result.total} — use --limit / --offset to page)\n`,
      );
    }
  });
}
