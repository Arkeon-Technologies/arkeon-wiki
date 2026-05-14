// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki sources scan` — file inventory by extension.
 *
 * Calls the daemon's GET /{space}/sources/scan and prints the
 * supported / unsupported partition. Useful as the first step in
 * setup — surfaces every binary or unknown-extension file the
 * watcher will silently ignore, so the operator can convert them to
 * a supported text format before letting agents run.
 *
 * Defaults to the space bound to the current directory (via
 * .arkeon/state.json); `--space <name>` overrides.
 */

import type { Command } from "commander";

import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";

interface SourcesScanOptions {
  space?: string;
}

interface ScanResponse {
  space: string;
  watch_dir: string;
  total: number;
  supported: { count: number; by_ext: Record<string, number> };
  unsupported: {
    count: number;
    by_ext: Record<string, number>;
    examples: Record<string, string[]>;
  };
}

export function registerSourcesCommand(program: Command): void {
  const cmd = program
    .command("sources")
    .description("Inspect the watch directory's source files");

  cmd
    .command("scan")
    .description(
      "Partition every file by extension into supported vs unsupported. " +
        "Unsupported files are silently ignored by the watcher.",
    )
    .option("--space <name>", "Space name (default: bound space)")
    .action(async (options: SourcesScanOptions) => {
      try {
        await runScan(options);
      } catch (error) {
        output.error(error, { operation: "sources scan" });
        process.exitCode = 1;
      }
    });
}

async function runScan(options: SourcesScanOptions): Promise<void> {
  const repoState = loadRepoState();
  const apiUrl =
    process.env.ARKE_API_URL ??
    repoState?.api_url ??
    `http://localhost:${DEFAULT_API_PORT}`;

  const space = options.space ?? repoState?.space_name;
  if (!space) {
    throw new Error(
      "sources scan: --space is required when not run inside an arkeon-wiki space (no .arkeon/state.json found).",
    );
  }

  const res = await fetch(
    `${apiUrl}/${encodeURIComponent(space)}/sources/scan`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (body as { error?: { message?: string } }).error?.message ?? res.statusText;
    throw new Error(`sources scan failed: ${res.status} ${message}`);
  }

  const result = (await res.json()) as ScanResponse;
  output.result({
    operation: "sources scan",
    space: result.space,
    watch_dir: result.watch_dir,
    total: result.total,
    supported: result.supported,
    unsupported: result.unsupported,
  });
}
