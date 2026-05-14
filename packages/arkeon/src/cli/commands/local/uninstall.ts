// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki uninstall` — stop the supervisor-managed daemon and
 * remove the plist/unit from disk.
 *
 * Idempotent: missing plist returns removed=false and exits 0.
 * Never touches ~/.arkeon-wiki/<name>/ data — that's the user's
 * knowledge graph, not a service artifact.
 */

import type { Command } from "commander";

import { applyName } from "../../lib/local-runtime.js";
import { DEFAULT_INSTANCE_NAME } from "../../lib/instances.js";
import { output } from "../../lib/output.js";
import { detectPlatform, getServiceManager } from "../../lib/service/index.js";

interface UninstallCliOptions {
  name?: string;
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("Remove a previously installed service")
    .option("--name <name>", "Uninstall a specific named-instance service")
    .action(async (opts: UninstallCliOptions) => {
      try {
        await runUninstall(opts);
      } catch (err) {
        output.error(err, { operation: "uninstall" });
        process.exitCode = 1;
      }
    });
}

async function runUninstall(opts: UninstallCliOptions): Promise<void> {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    throw new Error(
      `service uninstall is not supported on this platform. ` +
        `Currently: macOS (launchd), Linux (systemd, planned).`,
    );
  }

  const instanceName = opts.name ?? DEFAULT_INSTANCE_NAME;
  if (opts.name) applyName(opts.name);

  const manager = await getServiceManager(platform);
  const result = await manager.uninstall({ name: instanceName });

  output.result({
    operation: "uninstall",
    name: instanceName,
    platform,
    removed: result.removed,
    unit_path: result.unitPath,
  });
}
