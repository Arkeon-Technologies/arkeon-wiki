// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vitest e2e global setup.
 *
 * The cli-shellout test spawns `node dist/index.js` to exercise the
 * installed-binary code path — not just the in-process app.fetch.
 * That requires `dist/` to be present. CI starts from `npm ci` with
 * no build artifacts, so we run the build here. Tsup is incremental;
 * a no-op rebuild is sub-second.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");

export async function setup(): Promise<void> {
  process.stdout.write("[e2e] building dist (cli-shellout prerequisite)…\n");
  const r = spawnSync("npm", ["run", "build"], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`npm run build failed (exit ${r.status})`);
  }
}
