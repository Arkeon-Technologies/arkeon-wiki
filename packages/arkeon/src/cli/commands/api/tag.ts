// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki tag <path> <key>[=<value>]` — `POST /tag` (UPSERT).
 * `arkeon-wiki untag <path> <key>`           — `POST /untag`.
 *
 * The `=value` form mirrors `KEY=VALUE` shell conventions; the
 * key-only form lets workers drop "presence" tags with empty value.
 */

import type { Command } from "commander";

import { apiCall } from "../../lib/api-client.js";
import { isTty, printJson, printKeyValue } from "../../lib/format.js";
import {
  addCommonOptions,
  readGlobals,
  transportOptions,
} from "./_globals.js";

interface TagResponse {
  ok: true;
  path: string;
  key: string;
  value: string;
  previous_value: string | null;
  action: "created" | "updated" | "unchanged";
}

interface UntagResponse {
  ok: true;
  path: string;
  key: string;
  existed: boolean;
}

/** Split `key=value` (only on the *first* `=` so values may contain `=`). */
function splitKeyValue(spec: string): { key: string; value: string } {
  const idx = spec.indexOf("=");
  if (idx === -1) return { key: spec, value: "" };
  return { key: spec.slice(0, idx), value: spec.slice(idx + 1) };
}

export function registerTagCommands(program: Command): void {
  const tagCmd = addCommonOptions(
    program
      .command("tag <path> <keyValue>")
      .description("Upsert a tag on an artifact (key[=value])"),
  );
  tagCmd.action(async (path: string, keyValue: string, _o: unknown, command: Command) => {
    const { key, value } = splitKeyValue(keyValue);
    if (!key) {
      process.stderr.write(`arkeon-wiki: tag key cannot be empty\n`);
      process.exit(1);
    }
    const g = readGlobals(command);
    const result = await apiCall<TagResponse>(
      "POST",
      "/tag",
      { body: { path, key, value } },
      transportOptions(g),
    );
    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    printKeyValue([
      ["path", result.path],
      ["key", result.key],
      ["value", result.value || "(empty)"],
      ["action", result.action],
      ["previous_value", result.previous_value ?? "(none)"],
    ]);
  });

  const untagCmd = addCommonOptions(
    program
      .command("untag <path> <key>")
      .description("Remove a tag from an artifact (no-op if absent)"),
  );
  untagCmd.action(async (path: string, key: string, _o: unknown, command: Command) => {
    if (!key) {
      process.stderr.write(`arkeon-wiki: tag key cannot be empty\n`);
      process.exit(1);
    }
    const g = readGlobals(command);
    const result = await apiCall<UntagResponse>(
      "POST",
      "/untag",
      { body: { path, key } },
      transportOptions(g),
    );
    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    printKeyValue([
      ["path", result.path],
      ["key", result.key],
      ["action", result.existed ? "removed" : "no-op (tag was not set)"],
    ]);
  });
}
