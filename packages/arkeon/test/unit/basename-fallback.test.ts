// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  relativeHref,
  resolveByBasename,
} from "../../src/server/lib/basename-fallback.js";

describe("resolveByBasename", () => {
  it("returns null when the literal target already exists (no fallback needed)", () => {
    const known = new Set(["chartbook/article-one.html"]);
    expect(resolveByBasename("chartbook/article-one.html", known)).toBeNull();
  });

  it("returns the unique basename match when the literal target is missing", () => {
    // Simulates a file moved from chartbook/ to root: an inbound
    // href that still spells chartbook/article-one.html heals to
    // root article-one.html.
    const known = new Set(["article-one.html", "chartbook/other.html"]);
    expect(
      resolveByBasename("chartbook/article-one.html", known),
    ).toBe("article-one.html");
  });

  it("returns null when basename match is ambiguous (keeps redlink)", () => {
    // Same basename in two places. The render-time fallback can't
    // guess which one; surfaces as a redlink so a human disambiguates.
    const known = new Set([
      "iarpa/article.html",
      "chartbook/article.html",
    ]);
    expect(resolveByBasename("missing/article.html", known)).toBeNull();
  });

  it("returns null when basename has zero matches", () => {
    const known = new Set(["iarpa/other.html"]);
    expect(resolveByBasename("missing/article.html", known)).toBeNull();
  });

  it("is extension-strict (article.html does not heal to article.md)", () => {
    // Operators that specify .html in the href mean .html. A `.md`
    // file with a matching stem is NOT a valid fallback — it would
    // silently rewrite a wiki article link to its markdown source.
    const known = new Set(["iarpa/article.md"]);
    expect(resolveByBasename("chartbook/article.html", known)).toBeNull();
  });

  it("is case-insensitive (matches OS filesystem norms)", () => {
    const known = new Set(["iarpa/Article-One.html"]);
    expect(
      resolveByBasename("chartbook/article-one.html", known),
    ).toBe("iarpa/Article-One.html");
  });
});

describe("relativeHref", () => {
  it("computes a sibling href when source and target share a directory", () => {
    expect(relativeHref("chartbook/index.html", "chartbook/about.html")).toBe(
      "about.html",
    );
  });

  it("computes a parent-relative href when target lives one level up", () => {
    expect(
      relativeHref("chartbook/article-one.html", "article-one.html"),
    ).toBe("../article-one.html");
  });

  it("computes a child-relative href when target lives in a subfolder", () => {
    expect(relativeHref("iarpa/index.html", "iarpa/sources/notes.md")).toBe(
      "sources/notes.md",
    );
  });

  it("returns the bare target when the source lives at the watched root", () => {
    expect(relativeHref("index.html", "iarpa/article.html")).toBe(
      "iarpa/article.html",
    );
  });
});
