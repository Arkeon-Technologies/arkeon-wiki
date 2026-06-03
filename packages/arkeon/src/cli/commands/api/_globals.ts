// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for grabbing program-level and per-command options into the
 * shape `apiCall` expects. Centralized here so every command file
 * doesn't repeat the same `optsWithGlobals` boilerplate.
 */

import type { Command } from "commander";

import type { ApiCallOptions } from "../../lib/api-client.js";

export interface GlobalCliOptions {
  apiUrl?: string;
  name?: string;
  token?: string;
  json?: boolean;
}

/**
 * Pull `--api-url` (program-level), plus per-command `--name`,
 * `--token`, and `--json`. Commander merges program- and
 * command-scoped options into the same record via `optsWithGlobals`.
 */
export function readGlobals(command: Command): GlobalCliOptions {
  return command.optsWithGlobals() as GlobalCliOptions;
}

/** Build the transport-layer options that `apiCall` cares about. */
export function transportOptions(g: GlobalCliOptions): ApiCallOptions {
  return {
    apiUrl: g.apiUrl,
    name: g.name,
    token: g.token,
  };
}

/**
 * Attach the three flags every api command shares. Keeps the
 * registration sites tiny:
 *
 *   addCommonOptions(program.command("stats"))
 *     .description("...")
 *     .action(...)
 */
export function addCommonOptions(cmd: Command): Command {
  return cmd
    .option(
      "--api-url <url>",
      "Override API base URL (highest precedence)",
    )
    .option(
      "--name <name>",
      "Target a specific named instance (overrides CWD-based resolution)",
    )
    .option(
      "--token <token>",
      "Bearer token sent as Authorization (also ARKEON_WIKI_TOKEN)",
    )
    .option("--json", "Emit raw JSON even when stdout is a TTY");
}
