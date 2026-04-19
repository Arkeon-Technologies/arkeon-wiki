// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-mode commands that manage an Arkeon stack running on the
 * user's machine without Docker. This is the primary entry point for
 * self-hosting and the "try it in 30 seconds" OSS path.
 *
 * Two naming families for historical reasons:
 *
 *   Quickstart / daemon style (background, familiar to Docker users):
 *     arkeon up      — start as a detached daemon, apply LLM, save creds
 *     arkeon down    — stop the daemon (alias of stop)
 *     arkeon logs    — tail the daemon log
 *     arkeon status  — pid + health + ready + LLM/seed probes
 *     arkeon seed    — load the bundled Genesis demonstration wikis
 *
 *   Foreground / debugging style:
 *     arkeon start   — same stack, attached to the terminal, Ctrl+C drains
 *     arkeon stop    — stop the daemon (explicit form)
 *     arkeon migrate — run migrations only, no API
 *     arkeon reset   — wipe data (--hard also wipes secrets + binaries)
 *
 * `start` is the foreground orchestration; `up` is a detached-child
 * wrapper that waits for health and applies the pending LLM config.
 * `down` is a thin alias for `stop` (same handler).
 */

import { Command } from "commander";

import { registerUpCommand } from "./up.js";
import { registerStartCommand } from "./start.js";
import { registerStopCommand } from "./stop.js";
import { registerDownCommand } from "./down.js";
import { registerStatusCommand } from "./status.js";
import { registerLogsCommand } from "./logs.js";
import { registerSeedCommand } from "./seed.js";
import { registerMigrateCommand } from "./migrate.js";
import { registerResetCommand } from "./reset.js";
import { registerUpdateCommand } from "./update.js";

export function registerLocalCommands(program: Command): void {
  // Registration order = --help display order. Surface the daemon
  // flow first (init/up/down/logs/status/seed) since it's what new
  // users are copy-pasting from the README, then the foreground /
  // maintenance commands.
  registerUpCommand(program);
  registerDownCommand(program);
  registerLogsCommand(program);
  registerStatusCommand(program);
  registerSeedCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerUpdateCommand(program);
  registerMigrateCommand(program);
  registerResetCommand(program);
}
