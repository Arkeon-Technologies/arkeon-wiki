// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decides which file events trigger an agent. v1 ships with hardcoded
 * defaults: any path under the watched directory triggers EXCEPT
 * paths that would cause loops (`wiki/**`, the agent's own writes) or
 * touch internal state (`.arkeon/**`).
 *
 * `wiki/**` is intentionally not user-configurable — it's a safety
 * rail. Including it would make the ingestor re-trigger on its own
 * writes. When user-tunable include/exclude lands, this file becomes
 * the place that consumes that config.
 */

const ALWAYS_EXCLUDED_PREFIXES = ["wiki/", ".arkeon/"] as const;

/**
 * Should a file event at this relative path fire an agent?
 *
 * @param relativePath  Path relative to the space's watch_dir, with
 *                      forward slashes (matches what the watcher emits).
 */
export function shouldTrigger(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+/, "");
  for (const prefix of ALWAYS_EXCLUDED_PREFIXES) {
    if (normalized === prefix.slice(0, -1)) return false; // bare dir name
    if (normalized.startsWith(prefix)) return false;
  }
  return true;
}
