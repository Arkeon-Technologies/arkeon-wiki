// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Locate a bundled extractor helper script (Python or otherwise)
 * across dev + tarball layouts. Mirrors the schema locator pattern:
 * try the dev path next to the source first, then the bundled
 * `dist/extractor-scripts/` directory the build copies.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ExtractorScriptNotFoundError extends Error {
  constructor(scriptName: string, candidates: string[]) {
    super(
      `extractor script "${scriptName}" not found. Candidates tried:\n  - ${candidates.join("\n  - ")}`,
    );
    this.name = "ExtractorScriptNotFoundError";
  }
}

/**
 * Resolve the absolute path to a Python helper shipped under
 * `src/server/extractors/python/`. Throws if neither the dev nor the
 * tarball candidate exists — that's a packaging bug, not a runtime
 * condition the daemon should mask.
 */
export function resolvePythonScript(scriptName: string): string {
  const candidates = [
    // dev (tsx): __dirname = src/server/extractors/
    join(__dirname, "python", scriptName),
    // tarball: __dirname = dist/, scripts copied to dist/extractor-scripts/
    join(__dirname, "extractor-scripts", scriptName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ExtractorScriptNotFoundError(scriptName, candidates);
}

