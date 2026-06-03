// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lookup for the adapters manifest read at extraction time.
 *
 * The manifest records the resolved paths to bootstrapped tools — the
 * Python interpreter with PyMuPDF, system binaries, etc. In the
 * official Docker image it is baked at `/opt/arkeon-wiki/adapters.json`
 * (image build time); the runtime path is set via
 * `ARKEON_WIKI_ADAPTERS_PATH`.
 *
 * Outside the image there is no host-side bootstrap (the previous
 * `install-deps` command has been removed). Binary extraction therefore
 * requires running via the Docker image — when the manifest is missing,
 * we surface that loudly.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { arkeonDir } from "../../cli/lib/local-runtime.js";
import type { AdaptersManifest } from "./types.js";

const IMAGE_REF = "ghcr.io/arkeon-technologies/arkeon-wiki";

export class AdaptersManifestMissingError extends Error {
  constructor() {
    super(
      `adapters manifest not found — binary extractors (PDF, etc.) require the arkeon-wiki Docker image (${IMAGE_REF}). See docker-compose.example.yml for the recommended setup.`,
    );
    this.name = "AdaptersManifestMissingError";
  }
}

export function adaptersManifestPath(): string {
  // Explicit override wins (set by the Dockerfile, also handy for
  // tests). Falls back to the legacy host-side path otherwise.
  const override = process.env.ARKEON_WIKI_ADAPTERS_PATH;
  if (override) return override;
  return join(arkeonDir(), "adapters.json");
}

/**
 * Read the manifest from disk. Returns `null` if the file doesn't
 * exist so callers can decide whether that's fatal (extraction time)
 * or expected (daemon startup without binary handlers in play).
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
 * manifest is impossible.
 */
export function requireAdaptersManifest(): AdaptersManifest {
  const m = readAdaptersManifest();
  if (!m) throw new AdaptersManifestMissingError();
  return m;
}
