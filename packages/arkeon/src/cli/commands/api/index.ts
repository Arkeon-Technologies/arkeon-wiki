// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";

import { registerBacklinksCommand } from "./backlinks.js";
import { registerQueryCommand } from "./query.js";
import { registerReconcileCommand } from "./reconcile.js";
import { registerRedlinksCommand } from "./redlinks.js";
import { registerStatsCommand } from "./stats.js";
import { registerTagCommands } from "./tag.js";
import { registerTagsCommand } from "./tags.js";

/**
 * Register the substrate-API commands on the root program:
 * `query`, `tag`, `untag`, `tags`, `backlinks`, `redlinks`, `stats`,
 * `reconcile`.
 *
 * Each command maps 1:1 to an HTTP endpoint exposed by the daemon —
 * no SQLite direct reads, no caching.
 */
export function registerApiCommands(program: Command): void {
  registerQueryCommand(program);
  registerTagCommands(program);
  registerTagsCommand(program);
  registerBacklinksCommand(program);
  registerRedlinksCommand(program);
  registerStatsCommand(program);
  registerReconcileCommand(program);
}
