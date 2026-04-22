// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { registerLocalCommands } from "./cli/commands/local/index.js";
import { registerInitCommand } from "./cli/commands/repo/init.js";
import { registerWikiCommands } from "./cli/commands/repo/wiki.js";
import { registerFileCommands } from "./cli/commands/repo/file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

const program = new Command();

program
  .name("arkeon-wiki")
  .description("Filesystem-first knowledge graph")
  .version(pkg.version)
  .option("--api-url <url>", "Override API base URL")
  .option(
    "--data-dir <path>",
    "Root directory for Arkeon state (overrides ARKEON_WIKI_HOME)",
  );

program.hook("preAction", (command) => {
  const options = command.optsWithGlobals() as {
    apiUrl?: string;
    dataDir?: string;
  };
  if (options.apiUrl) {
    process.env.ARKE_API_URL = options.apiUrl;
  }
  if (options.dataDir) {
    process.env.ARKEON_WIKI_HOME = options.dataDir;
  }
});

registerLocalCommands(program);
registerInitCommand(program);
registerWikiCommands(program);
registerFileCommands(program);

program.parse();
