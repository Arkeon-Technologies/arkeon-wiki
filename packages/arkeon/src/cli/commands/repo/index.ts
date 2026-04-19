// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Repo-binding commands: init, pull, diff, add, rm.
 *
 * These manage the relationship between a local repository and an Arkeon
 * space — syncing entities as markdown files, registering documents,
 * detecting changes, and cleaning up deletions.
 */

import { Command } from "commander";

import { registerInitCommand } from "./init.js";
import { registerPullCommand } from "./pull.js";
import { registerDiffCommand } from "./diff.js";
import { registerAddCommand } from "./add.js";
import { registerRmCommand } from "./rm.js";

export function registerRepoCommands(program: Command): void {
  registerInitCommand(program);
  registerPullCommand(program);
  registerDiffCommand(program);
  registerAddCommand(program);
  registerRmCommand(program);
}
