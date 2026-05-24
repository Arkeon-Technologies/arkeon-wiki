// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  HANDLERS,
  HANDLERS_BY_EXT,
  INGESTABLE_EXTENSIONS,
  handlerFor,
} from "../../src/server/extractors/index.js";

describe("FileHandler registry", () => {
  it("contains a handler for .pdf", () => {
    expect(handlerFor("sources/paper.pdf")).not.toBeNull();
    expect(handlerFor("paper.PDF")).not.toBeNull(); // case insensitive
  });

  it("returns null for unsupported extensions", () => {
    expect(handlerFor("sources/note.txt")).toBeNull();
    expect(handlerFor("sources/picture.png")).toBeNull(); // images handled by fetch tool
    expect(handlerFor("sources/no-ext")).toBeNull();
  });

  it("INGESTABLE_EXTENSIONS is the union of all handler extensions", () => {
    const union = new Set(HANDLERS.flatMap((h) => h.extensions));
    expect(new Set(INGESTABLE_EXTENSIONS)).toEqual(union);
  });

  it("HANDLERS_BY_EXT keys all match INGESTABLE_EXTENSIONS", () => {
    expect(new Set(HANDLERS_BY_EXT.keys())).toEqual(
      new Set(INGESTABLE_EXTENSIONS),
    );
  });

  it("every handler has unique extensions across the registry", () => {
    const seen = new Set<string>();
    for (const h of HANDLERS) {
      for (const ext of h.extensions) {
        expect(seen.has(ext)).toBe(false);
        seen.add(ext);
      }
    }
  });

  it("every handler declares at least one dependency", () => {
    // Sanity: a handler that needs zero install-deps work would be an
    // unusual case; flag if we ever land one so install-deps's report
    // logic can be reviewed.
    for (const h of HANDLERS) {
      expect(h.dependencies.length).toBeGreaterThan(0);
    }
  });
});
