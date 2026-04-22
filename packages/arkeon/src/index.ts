// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { registerAuthCommands } from "./cli/commands/auth/index.js";
import { registerConfigCommands } from "./cli/commands/config/index.js";
import { registerDocsCommand } from "./cli/commands/docs/index.js";
import { registerEntityContentCommands } from "./cli/commands/entities/index.js";
import { registerGuideCommand } from "./cli/commands/guide/index.js";
import { registerLocalCommands } from "./cli/commands/local/index.js";
import { registerInstallCommands } from "./cli/commands/install/index.js";
import { registerFocusCommand } from "./cli/commands/focus.js";
import { registerRepoCommands } from "./cli/commands/repo/index.js";
import { syncSkillsIfNeeded } from "./cli/lib/skill-sync.js";
import { checkForUpdate } from "./cli/lib/version-check.js";
import { registerApiCommands } from "./generated/index.js";

// Read version from package.json so `npm version` in CI is the single source of truth.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

const program = new Command();

program
  .name("arkeon")
  .description("CLI for the Arkeon API")
  .version(pkg.version)
  .option("--api-url <url>", "Override API base URL for this process")
  .option("--space-id <id>", "Override default space ID for this process")
  .option(
    "--data-dir <path>",
    "Root directory for Arkeon state (overrides ARKEON_WIKI_HOME; affects all local commands)",
  );

program.hook("preAction", (command) => {
  const options = command.optsWithGlobals() as {
    apiUrl?: string;
    spaceId?: string;
    dataDir?: string;
  };
  if (options.apiUrl) {
    process.env.ARKE_API_URL = options.apiUrl;
  }
  if (options.spaceId) {
    process.env.ARKE_SPACE_ID = options.spaceId;
  }
  if (options.dataDir) {
    process.env.ARKEON_WIKI_HOME = options.dataDir;
  }
  syncSkillsIfNeeded(pkg.version);
  checkForUpdate(pkg.version);
});

registerRepoCommands(program);
registerFocusCommand(program);
registerInstallCommands(program);
registerLocalCommands(program);
registerAuthCommands(program);
registerConfigCommands(program);
registerEntityContentCommands(program);
registerGuideCommand(program);
registerApiCommands(program, { skipExisting: true });
registerDocsCommand(program); // last — needs the full command tree

program.parse();
