// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { registerApiCommands } from "./cli/commands/api/index.js";
import { registerLocalCommands } from "./cli/commands/local/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

const program = new Command();

program
  .name("arkeon-wiki")
  .description("Filesystem-first knowledge graph")
  .version(pkg.version)
  .option(
    "--data-dir <path>",
    "Root directory for Arkeon state (overrides ARKEON_WIKI_HOME)",
  );

program.hook("preAction", (command) => {
  const options = command.optsWithGlobals() as { dataDir?: string };
  if (options.dataDir) {
    process.env.ARKEON_WIKI_HOME = options.dataDir;
  }
  // `--api-url` is declared on each substrate-API command (via
  // `addCommonOptions`) rather than at the program level so users can
  // write `arkeon-wiki query --api-url X` — commander's program-level
  // options must appear before the subcommand, which is a surprising
  // failure mode worth avoiding.
});

registerLocalCommands(program);
registerApiCommands(program);

program.parse();
