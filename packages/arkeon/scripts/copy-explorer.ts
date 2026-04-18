// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Copies packages/explorer/dist → packages/cli/dist/explorer.
 *
 * Runs after `vite build` in packages/explorer as part of the CLI's
 * build step. The copied assets ship with the published `arkeon` npm
 * package so `arkeon start` can serve /explore without any build step
 * on the user's machine.
 *
 * This script is intentionally plain Node — no fancy bundler machinery —
 * so it's obvious what files move where.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const explorerDist = join(cliRoot, "..", "explorer", "dist");
const target = join(cliRoot, "dist", "explorer");

if (!existsSync(explorerDist)) {
  console.error(
    `[copy-explorer] explorer dist not found at ${explorerDist}. ` +
    `Did the \`npm run build -w packages/explorer\` step run?`,
  );
  process.exit(1);
}

// Ensure parent exists; wipe any previous copy so removed files don't linger.
mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target, { recursive: true, force: true });

cpSync(explorerDist, target, { recursive: true });
console.log(`[copy-explorer] copied ${explorerDist} → ${target}`);
