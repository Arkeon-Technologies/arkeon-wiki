// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry of all bundled file handlers. Adding a new format = import
 * its handler, drop it into the HANDLERS array. The watcher, install-
 * deps, and llms.txt all derive their behavior from this registry.
 */

import { extname } from "node:path";

import { pdfHandler } from "./pdf.js";
import type { FileHandler } from "./types.js";

export const HANDLERS: readonly FileHandler[] = [pdfHandler];

export const HANDLERS_BY_EXT: ReadonlyMap<string, FileHandler> = new Map(
  HANDLERS.flatMap((h) => h.extensions.map((ext) => [ext, h] as const)),
);

export const INGESTABLE_EXTENSIONS: ReadonlySet<string> = new Set(
  HANDLERS_BY_EXT.keys(),
);

/**
 * Return the handler that claims this path's extension, or `null` if
 * no handler is registered for it. Case-insensitive on the extension.
 */
export function handlerFor(relativePath: string): FileHandler | null {
  const ext = extname(relativePath).toLowerCase();
  return HANDLERS_BY_EXT.get(ext) ?? null;
}

export type { FileHandler, ExtractContext, ExtractResult, DependencySpec, AdaptersManifest } from "./types.js";
