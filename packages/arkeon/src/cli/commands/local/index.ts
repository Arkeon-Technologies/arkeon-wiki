// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";

import { registerDownCommand } from "./down.js";
import { registerLogsCommand } from "./logs.js";
import { registerLsCommand } from "./ls.js";
import { registerStartCommand } from "./start.js";
import { registerStatusCommand } from "./status.js";
import { registerStopCommand } from "./stop.js";
import { registerUpCommand } from "./up.js";

export function registerLocalCommands(program: Command): void {
  registerUpCommand(program);
  registerDownCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerStatusCommand(program);
  registerLsCommand(program);
  registerLogsCommand(program);
}
