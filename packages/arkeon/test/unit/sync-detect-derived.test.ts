// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-logic tests for `detectDerivedFrom` — the derived-asset path
 * recognizer that powers `properties.derived_from` on extractor
 * outputs (PDF page-renders today, future handlers tomorrow).
 */

import { describe, expect, it } from "vitest";

import { detectDerivedFrom } from "../../src/server/lib/sync.js";

describe("detectDerivedFrom", () => {
  it("recognizes a top-level binary's page render", () => {
    expect(
      detectDerivedFrom(".sidecars/paper.pdf.assets/page-1.png"),
    ).toBe("paper.pdf");
  });

  it("recognizes a nested binary's page render", () => {
    expect(
      detectDerivedFrom(".sidecars/iarpa/sources/paper.pdf.assets/page-1.png"),
    ).toBe("iarpa/sources/paper.pdf");
  });

  it("recognizes embedded-figure assets (page-N-fig-M.<ext>)", () => {
    expect(
      detectDerivedFrom(
        ".sidecars/iarpa/sources/paper.pdf.assets/page-3-fig-1.png",
      ),
    ).toBe("iarpa/sources/paper.pdf");
  });

  it("returns null for primary assets outside .sidecars/", () => {
    expect(detectDerivedFrom("iarpa/sources/paper.pdf")).toBeNull();
  });

  it("returns null for a sidecar HTML (not a derived asset)", () => {
    expect(detectDerivedFrom(".sidecars/iarpa/paper.pdf.html")).toBeNull();
  });

  it("returns null for .sidecars/ paths with no .assets/ segment", () => {
    expect(detectDerivedFrom(".sidecars/random.png")).toBeNull();
  });

  it("returns null when the asset name contains a nested slash", () => {
    expect(
      detectDerivedFrom(".sidecars/paper.pdf.assets/subdir/page-1.png"),
    ).toBeNull();
  });

  it("returns null when the asset name is empty (path ends at .assets/)", () => {
    expect(detectDerivedFrom(".sidecars/paper.pdf.assets/")).toBeNull();
  });

  it("uses the LAST .assets/ when a binary's own basename contains .assets", () => {
    // Pathological but legal: `weird.assets` binary → assets dir is
    // `weird.assets.assets/`. lastIndexOf should pick the trailing
    // boundary, not the embedded one.
    expect(
      detectDerivedFrom(".sidecars/iarpa/weird.assets.assets/page-1.png"),
    ).toBe("iarpa/weird.assets");
  });
});
