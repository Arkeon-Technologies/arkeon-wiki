// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";

import { registerDownCommand } from "./down.js";
import { registerInstallCommand } from "./install.js";
import { registerInstallDepsCommand } from "./install-deps.js";
import { registerLogsCommand } from "./logs.js";
import { registerLsCommand } from "./ls.js";
import { registerStartCommand } from "./start.js";
import { registerStatusCommand } from "./status.js";
import { registerStopCommand } from "./stop.js";
import { registerUninstallCommand } from "./uninstall.js";
import { registerUpCommand } from "./up.js";
import { registerWhereCommand } from "./where.js";

export function registerLocalCommands(program: Command): void {
  registerUpCommand(program);
  registerDownCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerStatusCommand(program);
  registerLsCommand(program);
  registerLogsCommand(program);
  registerWhereCommand(program);
  registerInstallCommand(program);
  registerInstallDepsCommand(program);
  registerUninstallCommand(program);
}
