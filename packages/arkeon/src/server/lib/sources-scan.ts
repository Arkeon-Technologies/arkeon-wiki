// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source inventory for a space's watch directory.
 *
 * Walks the directory once, partitions every regular file via
 * `isEligibleFile()` (the same three-tier check the watcher applies:
 * binary-ext denylist → text-ext allowlist → content sniff), and
 * reports counts plus a handful of example paths per unsupported
 * extension so the operator (or an LLM agent) can decide what to
 * convert.
 *
 * The walk reuses the ignore rules from fs-watcher (shouldIgnorePath)
 * so what the scan reports lines up exactly with what the watcher
 * will or won't index.
 */

import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { isEligibleFile, shouldIgnorePath } from "./fs-watcher.js";

/** Per-extension counts, sorted descending by count. */
export interface ExtensionBucket {
  count: number;
  by_ext: Record<string, number>;
}

export interface UnsupportedBucket extends ExtensionBucket {
  /** Up to EXAMPLES_PER_EXT paths per extension, space-relative. */
  examples: Record<string, string[]>;
}

export interface ScanResult {
  total: number;
  supported: ExtensionBucket;
  unsupported: UnsupportedBucket;
}

const EXAMPLES_PER_EXT = 5;

/**
 * Walk `watchDir` and partition every file by extension. Hidden dirs
 * and well-known ignore dirs (.git, node_modules, .arkeon, ...) are
 * skipped — same rule the watcher applies.
 *
 * Synchronous fs is fine here: this runs once on operator demand, not
 * in a hot path. Cost is O(N) over every file in the watch tree —
 * a corpus of tens of thousands of files blocks the event loop for
 * the duration of the walk. Acceptable for v0 because the endpoint
 * is operator-triggered (one shot, not a request you fan out). If
 * usage outgrows that, the natural next step is async readdir + a
 * max-files truncation signal, or serving from a count the watcher
 * maintains.
 */
export function scanSources(watchDir: string): ScanResult {
  const supportedByExt: Record<string, number> = {};
  const unsupportedByExt: Record<string, number> = {};
  const unsupportedExamples: Record<string, string[]> = {};
  let total = 0;

  walk(watchDir, "", (relativePath) => {
    total += 1;
    const ext = extname(relativePath).toLowerCase();
    // Files with no extension live under the "(none)" bucket so the
    // operator sees them — many sources arrive as `README` or `LICENSE`
    // with no suffix, and silently lumping them with `.xyz` would hide
    // them from the conversion plan.
    const bucketKey = ext === "" ? "(none)" : ext;
    const absPath = join(watchDir, relativePath);
    if (isEligibleFile(relativePath, absPath)) {
      supportedByExt[bucketKey] = (supportedByExt[bucketKey] ?? 0) + 1;
    } else {
      unsupportedByExt[bucketKey] = (unsupportedByExt[bucketKey] ?? 0) + 1;
      const examples = unsupportedExamples[bucketKey] ?? [];
      if (examples.length < EXAMPLES_PER_EXT) {
        examples.push(relativePath);
      }
      unsupportedExamples[bucketKey] = examples;
    }
  });

  return {
    total,
    supported: {
      count: sumValues(supportedByExt),
      by_ext: sortByCountDesc(supportedByExt),
    },
    unsupported: {
      count: sumValues(unsupportedByExt),
      by_ext: sortByCountDesc(unsupportedByExt),
      examples: unsupportedExamples,
    },
  };
}

function walk(
  root: string,
  prefix: string,
  visit: (relativePath: string) => void,
): void {
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (shouldIgnorePath(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(root, relativePath, visit);
    } else if (entry.isFile()) {
      visit(relativePath);
    }
    // Symlinks fall through both branches (isDirectory and isFile
    // are false for them) and are silently skipped — matches the
    // watcher's behavior in fs-watcher.ts so the inventory stays
    // consistent with what gets indexed.
  }
}

function sumValues(record: Record<string, number>): number {
  let sum = 0;
  for (const v of Object.values(record)) sum += v;
  return sum;
}

function sortByCountDesc(record: Record<string, number>): Record<string, number> {
  const entries = Object.entries(record).sort(([, a], [, b]) => b - a);
  return Object.fromEntries(entries);
}
