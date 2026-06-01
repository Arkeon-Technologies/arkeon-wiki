// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve, sep } from "node:path";

/**
 * Resolve a relative path against a watch dir, rejecting absolute
 * paths and `..` escapes. Used wherever path strings cross a trust
 * boundary (HTTP body, URL).
 */
export function safeResolve(watchDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(
      `path '${relativePath}' is absolute; must be relative to the watch dir`,
    );
  }
  if (relativePath.includes("\0")) {
    throw new Error(`path '${relativePath}' contains a NUL byte`);
  }
  const baseAbs = resolve(watchDir);
  const candidate = resolve(baseAbs, relativePath);
  if (candidate !== baseAbs && !candidate.startsWith(baseAbs + sep)) {
    throw new Error(
      `path '${relativePath}' escapes the space's watch directory`,
    );
  }
  return candidate;
}
