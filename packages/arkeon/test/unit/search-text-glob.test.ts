// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard: the search tool's ripgrep `--type-add` glob is built
 * from TEXT_EXTENSIONS at module load. If someone adds a new text
 * extension to fs-watcher and forgets that search uses a separate
 * filter, the lists would drift — except they're now derived from
 * the same source. This test asserts that derivation directly so a
 * future refactor can't silently break the alignment.
 */

import { describe, expect, it } from "vitest";

import {
  ASSET_EXTENSIONS,
  TEXT_EXTENSIONS,
  TEXT_EXTENSION_GLOB,
} from "../../src/server/lib/fs-watcher.js";

describe("search ↔ TEXT_EXTENSIONS alignment", () => {
  it("covers every brace-safe TEXT_EXTENSIONS entry", () => {
    for (const ext of TEXT_EXTENSIONS) {
      const bare = ext.slice(1);
      if (!/^[a-z0-9_]+$/.test(bare)) continue; // filter applied at build time
      // The glob is `*.{a,b,c,...}`; assert the bare extension appears
      // surrounded by either `{` `,` or `,` `}` (or `{` `}` for single).
      const inGroup = new RegExp(`[{,]${bare}[,}]`);
      expect(TEXT_EXTENSION_GLOB).toMatch(inGroup);
    }
  });

  it("excludes every ASSET_EXTENSIONS entry", () => {
    for (const ext of ASSET_EXTENSIONS) {
      const bare = ext.slice(1);
      const inGroup = new RegExp(`[{,]${bare}[,}]`);
      expect(TEXT_EXTENSION_GLOB).not.toMatch(inGroup);
    }
  });

  it("has the expected glob shape", () => {
    expect(TEXT_EXTENSION_GLOB.startsWith("*.{")).toBe(true);
    expect(TEXT_EXTENSION_GLOB.endsWith("}")).toBe(true);
  });
});
