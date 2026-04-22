// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";

import { registerStartCommand } from "./start.js";
import { registerStopCommand } from "./stop.js";
import { registerStatusCommand } from "./status.js";

export function registerLocalCommands(program: Command): void {
  registerStartCommand(program);
  registerStopCommand(program);
  registerStatusCommand(program);
}
