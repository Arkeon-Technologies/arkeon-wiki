// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * .env loader for the agent runtime.
 *
 * Two officially-supported locations, in increasing specificity:
 *
 *   1. ~/.arkeon-wiki/.env     "set once for all my spaces" (user-global)
 *   2. <space.watch_dir>/.env  per-repo override (gitignored by `init`)
 *
 * The shell environment always wins over both — explicit `export
 * OPENAI_API_KEY=...` (or a secret manager) takes precedence. This
 * matches the conventions of git config, dotenv-flow, and most
 * 12-factor tooling.
 *
 * Precedence (most specific wins):
 *
 *   shell env  >  <space>/.env  >  ~/.arkeon-wiki/.env
 *
 * Used by the manual demo and (when #49 lands) the daemon entrypoint.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { config as dotenvConfig } from "dotenv";

export interface LoadAgentEnvOptions {
  /** Per-space directory; if set, look at {spaceDir}/.env there too. */
  spaceDir?: string;
  /** Override the user-global .env path (mainly for tests). */
  userGlobalPath?: string;
}

export interface LoadAgentEnvResult {
  /** Paths that existed and were loaded, in load order. */
  loaded: string[];
}

const USER_GLOBAL_PATH = join(homedir(), ".arkeon-wiki", ".env");

/**
 * Load .env files in the right precedence order. Existing process env
 * vars (set by the shell) are never overridden — they always win.
 */
export function loadAgentEnv(opts: LoadAgentEnvOptions = {}): LoadAgentEnvResult {
  // Snapshot keys that came from the shell (or any earlier load) before
  // we touch process.env. These are protected: nothing we read from
  // .env will overwrite them.
  const shellKeys = new Set(Object.keys(process.env));

  const userGlobal = opts.userGlobalPath ?? USER_GLOBAL_PATH;
  const repoLocal = opts.spaceDir ? join(opts.spaceDir, ".env") : null;
  const loaded: string[] = [];

  // Load user-global first; per-repo can override.
  loadAndMerge(userGlobal, shellKeys, loaded);
  if (repoLocal) loadAndMerge(repoLocal, shellKeys, loaded);

  return { loaded };
}

function loadAndMerge(
  path: string,
  shellKeys: Set<string>,
  loaded: string[],
): void {
  if (!existsSync(path)) return;
  // Parse into a side-buffer so we can decide per-key whether to apply.
  const buffer: Record<string, string> = {};
  dotenvConfig({ path, processEnv: buffer, quiet: true });
  for (const [k, v] of Object.entries(buffer)) {
    if (shellKeys.has(k)) continue;        // shell wins — never overwrite
    process.env[k] = v;                    // file wins over earlier file
  }
  loaded.push(path);
}
