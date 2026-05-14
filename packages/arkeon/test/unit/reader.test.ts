// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-function tests for the Phase 2 reader primitives. No server, no
 * DB — every test passes its own `knownPaths` Set to mimic the entity
 * lookup the route would do.
 */

import { describe, it, expect } from "vitest";

import {
  classifyAnchor,
  instrumentArticle,
  renderArticleIndex,
  renderSpaceIndex,
} from "../../src/server/lib/reader.js";

describe("classifyAnchor", () => {
  const known = new Set(["wiki/chloroplast.html", "sources/shannon-1948.md"]);
  const from = "wiki/photosynthesis.html";

  it("tags an existing .html target as arkeon-wiki", () => {
    expect(classifyAnchor("chloroplast.html", from, known)).toEqual(["arkeon-wiki"]);
  });

  it("tags an existing non-html target as arkeon-file", () => {
    expect(classifyAnchor("../sources/shannon-1948.md", from, known)).toEqual([
      "arkeon-file",
    ]);
  });

  it("tags a missing .html target as arkeon-wiki + arkeon-redlink", () => {
    expect(classifyAnchor("ghost.html", from, known)).toEqual([
      "arkeon-wiki",
      "arkeon-redlink",
    ]);
  });

  it("tags a missing source target as arkeon-file + arkeon-redlink", () => {
    expect(classifyAnchor("../sources/missing.md", from, known)).toEqual([
      "arkeon-file",
      "arkeon-redlink",
    ]);
  });

  it("drops external links", () => {
    expect(classifyAnchor("https://example.com", from, known)).toEqual([]);
    expect(classifyAnchor("mailto:x@y", from, known)).toEqual([]);
    expect(classifyAnchor("tel:555", from, known)).toEqual([]);
  });

  it("drops fragments and protocol-relative URLs", () => {
    expect(classifyAnchor("#section", from, known)).toEqual([]);
    expect(classifyAnchor("//example.com/x", from, known)).toEqual([]);
  });

  it("drops server-absolute paths (reserved for cross-space in v0.5)", () => {
    expect(classifyAnchor("/other-space/wiki/x.html", from, known)).toEqual([]);
  });

  it("drops paths that escape the space root", () => {
    expect(classifyAnchor("../../etc/passwd", from, known)).toEqual([]);
  });

  it("is case-insensitive on the .html extension check", () => {
    expect(classifyAnchor("photo.HTML", from, known)).toEqual([
      "arkeon-wiki",
      "arkeon-redlink",
    ]);
  });

  it("matches percent-escaped hrefs against decoded entity paths", () => {
    // Filenames with spaces/`&` are URL-encoded in hrefs but stored as
    // real characters in entities.source_path. Without decoding, these
    // would falsely flag as red links.
    const knownEncoded = new Set([
      "files/Milestones & Schedules/README.md",
    ]);
    expect(
      classifyAnchor(
        "../files/Milestones%20%26%20Schedules/README.md",
        from,
        knownEncoded,
      ),
    ).toEqual(["arkeon-file"]);
  });
});

describe("instrumentArticle", () => {
  const known = new Set(["wiki/chloroplast.html", "sources/shannon-1948.md"]);
  const articlePath = "wiki/photosynthesis.html";

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Photosynthesis</title></head>
<body>
<h1>Photosynthesis</h1>
<p><a href="chloroplast.html">chloro</a></p>
<p><a href="ghost.html">ghost</a></p>
<p><a href="../sources/shannon-1948.md">shannon</a></p>
<p><a href="https://wikipedia.org">wikipedia</a></p>
</body>
</html>`;

  it("tags links with the right classes", () => {
    const out = instrumentArticle(html, articlePath, known, "demo");
    expect(out).toContain(`<a href="chloroplast.html" class="arkeon-wiki">`);
    expect(out).toContain(
      `<a href="ghost.html" class="arkeon-wiki arkeon-redlink">`,
    );
    expect(out).toContain(
      `<a href="../sources/shannon-1948.md" class="arkeon-file">`,
    );
    // External link: no class added.
    expect(out).toContain(`<a href="https://wikipedia.org">wikipedia</a>`);
  });

  it("injects the chrome div under <body>", () => {
    const out = instrumentArticle(html, articlePath, known, "demo");
    expect(out).toContain(`<div id="arkeon-chrome">`);
    expect(out).toContain(`href="/demo/"`);
    // Chrome must appear before the article content.
    const chromeIdx = out.indexOf("arkeon-chrome");
    const h1Idx = out.indexOf("<h1>");
    expect(chromeIdx).toBeGreaterThan(0);
    expect(chromeIdx).toBeLessThan(h1Idx);
  });

  it("injects the chrome style block in <head>", () => {
    const out = instrumentArticle(html, articlePath, known, "demo");
    expect(out).toContain(`<style data-arkeon-chrome>`);
    expect(out).toContain(`#arkeon-chrome`);
    // All three link classes get a visual treatment that distinguishes
    // them from each other and from external links:
    //   wiki   → browser default (blue, solid underline)
    //   file   → muted slate + dotted underline ("reference" feel)
    //   redlink → red (overrides color of either of the above)
    expect(out).toContain(`a.arkeon-file`);
    expect(out).toContain(`text-decoration: underline dotted`);
    expect(out).toContain(`a.arkeon-redlink`);
  });

  it("preserves existing class attributes on anchors", () => {
    const withExisting = `<!doctype html><html><head><title>x</title></head>
<body><a class="important" href="chloroplast.html">c</a></body></html>`;
    const out = instrumentArticle(withExisting, articlePath, known, "demo");
    expect(out).toContain(`class="important arkeon-wiki"`);
  });

  it("does not double-inject chrome if re-run", () => {
    const once = instrumentArticle(html, articlePath, known, "demo");
    const twice = instrumentArticle(once, articlePath, known, "demo");
    expect(twice.match(/id="arkeon-chrome"/g)?.length).toBe(1);
    expect(twice.match(/data-arkeon-chrome/g)?.length).toBe(1);
  });

  it("escapes HTML in the space name shown in the chrome", () => {
    const out = instrumentArticle(html, articlePath, known, "<bad>");
    expect(out).toContain("&lt;bad&gt;");
    expect(out).not.toContain("<bad>");
  });
});

describe("renderSpaceIndex", () => {
  it("renders a list of spaces with their entity counts", () => {
    const out = renderSpaceIndex([
      { name: "augustine", entity_count: 42 },
      { name: "notes", entity_count: 1 },
    ]);
    expect(out).toContain("<title>arkeon-wiki</title>");
    expect(out).toContain(`<a href="/augustine/">augustine</a>`);
    expect(out).toContain("42 entities");
    expect(out).toContain(`<a href="/notes/">notes</a>`);
    expect(out).toContain("1 entity");
  });

  it("renders an empty-state hint when no spaces are registered", () => {
    const out = renderSpaceIndex([]);
    expect(out).toContain("no spaces registered yet");
    expect(out).toContain("arkeon-wiki init");
  });

  it("escapes space names safely", () => {
    const out = renderSpaceIndex([{ name: "<x>", entity_count: 0 }]);
    expect(out).toContain("&lt;x&gt;");
    expect(out).toContain("/%3Cx%3E/");
  });
});

describe("renderArticleIndex", () => {
  it("sorts alphabetically by label (case-insensitive)", () => {
    const out = renderArticleIndex("demo", [
      { source_path: "wiki/zebra.html", label: "Zebra", short_description: null },
      { source_path: "wiki/apple.html", label: "apple", short_description: null },
      { source_path: "wiki/banana.html", label: "Banana", short_description: null },
    ]);
    const appleIdx = out.indexOf("apple");
    const bananaIdx = out.indexOf("Banana");
    const zebraIdx = out.indexOf("Zebra");
    expect(appleIdx).toBeLessThan(bananaIdx);
    expect(bananaIdx).toBeLessThan(zebraIdx);
  });

  it("links to /:space/<source_path>", () => {
    const out = renderArticleIndex("demo", [
      {
        source_path: "wiki/biology/chlorophyll.html",
        label: "Chlorophyll",
        short_description: null,
      },
    ]);
    expect(out).toContain(`href="/demo/wiki/biology/chlorophyll.html"`);
  });

  it("renders short_description as a subtitle when present", () => {
    const out = renderArticleIndex("demo", [
      {
        source_path: "wiki/x.html",
        label: "X",
        short_description: "The letter X.",
      },
    ]);
    expect(out).toContain(`<p class="desc">The letter X.</p>`);
  });

  it("falls back to filename when label is missing", () => {
    const out = renderArticleIndex("demo", [
      { source_path: "wiki/orphan.html", label: null, short_description: null },
    ]);
    expect(out).toContain(">orphan.html</a>");
  });

  it("escapes labels and descriptions for XSS safety", () => {
    const out = renderArticleIndex("demo", [
      {
        source_path: "wiki/x.html",
        label: "<script>alert(1)</script>",
        short_description: '"; drop',
      },
    ]);
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&quot;");
  });
});
