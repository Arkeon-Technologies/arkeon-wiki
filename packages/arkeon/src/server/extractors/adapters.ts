// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence + lookup for the adapters manifest written by
 * `arkeon-wiki install-deps` and read at extraction time.
 *
 * The manifest records the resolved paths to bootstrapped tools — the
 * managed Python venv's `python` binary, system binary locations
 * (pandoc, etc.), and a registry of installed Python packages. Lives
 * at `~/.arkeon-wiki/adapters.json` (overridable via
 * `ARKEON_WIKI_HOME`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { arkeonDir, ensureArkeonDir } from "../../cli/lib/local-runtime.js";
import type { AdaptersManifest } from "./types.js";

export class AdaptersManifestMissingError extends Error {
  constructor() {
    super(
      "adapters manifest not found — run `arkeon-wiki install-deps` to bootstrap the binary ingestion toolchain",
    );
    this.name = "AdaptersManifestMissingError";
  }
}

export function adaptersManifestPath(): string {
  return join(arkeonDir(), "adapters.json");
}

/**
 * Read the manifest from disk. Returns `null` if the file doesn't
 * exist (install-deps was never run) so callers can decide whether
 * that's fatal (extraction time) or expected (daemon startup).
 */
export function readAdaptersManifest(): AdaptersManifest | null {
  const path = adaptersManifestPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AdaptersManifest;
    if (parsed.schema_version !== 1) {
      throw new Error(
        `adapters manifest schema_version ${parsed.schema_version} is not supported (expected 1)`,
      );
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `failed to read adapters manifest at ${path}: ${(err as Error).message}`,
    );
  }
}

/**
 * Read the manifest or throw `AdaptersManifestMissingError` if it
 * doesn't exist. Use at extraction time where running without the
 * manifest is impossible (the handler couldn't have been registered as
 * enabled without it).
 */
export function requireAdaptersManifest(): AdaptersManifest {
  const m = readAdaptersManifest();
  if (!m) throw new AdaptersManifestMissingError();
  return m;
}

export function writeAdaptersManifest(manifest: AdaptersManifest): string {
  ensureArkeonDir();
  const path = adaptersManifestPath();
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return path;
}
