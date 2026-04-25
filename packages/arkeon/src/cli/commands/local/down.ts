// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki down` — alias for `stop`. Same flags, same behavior.
 *
 * Both names exist because users coming from `docker compose` reach for
 * `down` and users coming from systemd reach for `stop`.
 */

import type { Command } from "commander";

import { runStop } from "./stop.js";

export function registerDownCommand(program: Command): void {
  program
    .command("down")
    .description("Stop a running Arkeon instance (alias: stop)")
    .option("--name <name>", "Stop a named instance started with `--name <name>`")
    .option("--timeout <ms>", "How long to wait for graceful shutdown", "30000")
    .action(async (options: { name?: string; timeout: string }) => {
      await runStop(options);
    });
}
