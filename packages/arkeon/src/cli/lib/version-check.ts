// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-blocking version check. On every CLI invocation:
 *
 *   1. Read ~/.arkeon-wiki/version-check.json (cached latest version + timestamp)
 *   2. If cache is fresh (<24h) and a newer version exists, print a warning
 *   3. If cache is stale or missing, spawn a background `npm view` to refresh it
 *
 * The background spawn is fire-and-forget — it never delays the current command.
 * The warning appears on the *next* invocation after the check completes.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHECK_FILE = "version-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface VersionCache {
  checked_at: string;
  latest: string;
}

function cachePath(): string {
  return join(process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki"), CHECK_FILE);
}

function readCache(): VersionCache | null {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as VersionCache;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    const dir = process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
    mkdirSync(dir, { recursive: true });
    const data: VersionCache = { checked_at: new Date().toISOString(), latest };
    writeFileSync(cachePath(), JSON.stringify(data) + "\n");
  } catch {
    // Non-fatal
  }
}

/**
 * Compare two semver strings. Returns true if remote > local.
 */
export function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Spawn a background process to check the latest npm version.
 * Detached + unref'd so the CLI can exit immediately.
 */
function spawnBackgroundCheck(): void {
  try {
    const child = spawn("npm", ["view", "arkeon", "version", "--json"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        // npm view --json wraps in quotes: "0.3.5"
        const version = stdout.trim().replace(/^"|"$/g, "");
        if (/^\d+\.\d+\.\d+/.test(version)) {
          writeCache(version);
        }
      }
    });

    child.unref();
  } catch {
    // Non-fatal
  }
}

export function checkForUpdate(currentVersion: string): void {
  try {
    const cache = readCache();

    if (cache) {
      const age = Date.now() - new Date(cache.checked_at).getTime();

      if (age < CHECK_INTERVAL_MS) {
        // Cache is fresh — warn if newer version exists
        if (isNewer(cache.latest, currentVersion)) {
          const msg = `\x1b[33mUpdate available: arkeon ${cache.latest} (current: ${currentVersion}). Run \`arkeon update\` to update.\x1b[0m`;
          process.stderr.write(msg + "\n");
        }
        return;
      }
    }

    // Cache is stale or missing — refresh in background
    spawnBackgroundCheck();
  } catch {
    // Never let version check break the CLI
  }
}
