// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import { extractHtmlLinks, resolveHref } from "../../src/server/lib/html-links.js";

describe("resolveHref", () => {
  it("resolves a sibling article from a top-level wiki", () => {
    expect(resolveHref("other.html", "wiki/foo.html")).toBe("wiki/other.html");
  });

  it("resolves a parent-dir source from a wiki", () => {
    expect(resolveHref("../sources/shannon-1948.md", "wiki/photosynthesis.html"))
      .toBe("sources/shannon-1948.md");
  });

  it("resolves a subfolder article from a top-level wiki", () => {
    expect(resolveHref("biology/chlorophyll.html", "wiki/foo.html"))
      .toBe("wiki/biology/chlorophyll.html");
  });

  it("resolves a parent-relative path from a subfolder wiki", () => {
    expect(resolveHref("../foo.html", "wiki/biology/chlorophyll.html"))
      .toBe("wiki/foo.html");
  });

  it("strips fragment and query", () => {
    expect(resolveHref("other.html#section", "wiki/foo.html")).toBe("wiki/other.html");
    expect(resolveHref("other.html?v=1", "wiki/foo.html")).toBe("wiki/other.html");
  });

  it("drops external URLs", () => {
    expect(resolveHref("https://en.wikipedia.org/wiki/X", "wiki/foo.html")).toBeNull();
    expect(resolveHref("http://example.com", "wiki/foo.html")).toBeNull();
    expect(resolveHref("mailto:x@y.com", "wiki/foo.html")).toBeNull();
    expect(resolveHref("tel:+1234", "wiki/foo.html")).toBeNull();
  });

  it("drops protocol-relative URLs", () => {
    expect(resolveHref("//example.com/x", "wiki/foo.html")).toBeNull();
  });

  it("drops server-absolute paths (single watched root)", () => {
    expect(resolveHref("/other-space/wiki/foo.html", "wiki/foo.html")).toBeNull();
  });

  it("drops bare slash", () => {
    expect(resolveHref("/", "wiki/foo.html")).toBeNull();
  });

  it("drops pure fragments", () => {
    expect(resolveHref("#section", "wiki/foo.html")).toBeNull();
  });

  it("drops paths that escape the space root", () => {
    expect(resolveHref("../../etc/passwd", "wiki/foo.html")).toBeNull();
    expect(resolveHref("../../../foo", "wiki/biology/x.html")).toBeNull();
  });

  it("decodes percent-escaped path segments", () => {
    expect(
      resolveHref(
        "../IARPA_Bengal/Milestones%20%26%20Schedules/A1/Data/README.md",
        "wiki/foo.html",
      ),
    ).toBe("IARPA_Bengal/Milestones & Schedules/A1/Data/README.md");
    expect(resolveHref("../My%20Notes/x.html", "wiki/foo.html")).toBe(
      "My Notes/x.html",
    );
  });

  it("tolerates malformed percent encoding", () => {
    // Invalid `%` sequence → fall back to the raw string rather than throw.
    expect(resolveHref("../foo%2/bar.html", "wiki/x.html")).toBe(
      "foo%2/bar.html",
    );
  });

});

describe("extractHtmlLinks", () => {
  it("only extracts <a class='wikilink'> anchors", () => {
    const html = `<!doctype html><title>X</title>
<body>
  <p>
    <a class="wikilink" href="other.html">wikilink-other</a>
    <a href="../sources/p.md">plain-anchor</a>
    <a class="wikilink" href="https://en.wikipedia.org/x">external-wiki</a>
  </p>
  <a class="other wikilink" href="biology/chlorophyll.html">multi-class</a>
</body>`;
    const links = extractHtmlLinks(html, "wiki/foo.html");
    expect(links).toHaveLength(3);

    const resolved = links.filter((l) => l.resolved !== null);
    expect(resolved.map((l) => ({ resolved: l.resolved, text: l.text }))).toEqual([
      { resolved: "wiki/other.html", text: "wikilink-other" },
      { resolved: "wiki/biology/chlorophyll.html", text: "multi-class" },
    ]);

    const external = links.find((l) => l.href.startsWith("https://"));
    expect(external?.resolved).toBeNull();
  });

  it("returns empty array for HTML without wikilink anchors", () => {
    expect(extractHtmlLinks("<a href='x.html'>plain</a>", "wiki/foo.html")).toEqual([]);
  });

  it("skips wikilink anchors without an href attribute", () => {
    const html = `<a class="wikilink">no-href</a><a class="wikilink" href="x.html">x</a>`;
    const links = extractHtmlLinks(html, "wiki/foo.html");
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("x");
  });

  it("captures data-* attributes on wikilink anchors", () => {
    const html = `<a class="wikilink" href="paper.pdf.html" data-quote="lorem" data-page="3" data-cite-type="evidence">paper</a>`;
    const links = extractHtmlLinks(html, "wiki/foo.html");
    expect(links).toHaveLength(1);
    expect(links[0].data).toEqual({
      quote: "lorem",
      page: "3",
      "cite-type": "evidence",
    });
  });

  it("does NOT extract <img src> (assets resolve via the reader, not the link graph)", () => {
    const html = `<img src="../images/chart.png" alt="chart">`;
    expect(extractHtmlLinks(html, "wiki/foo.html")).toEqual([]);
  });

  it("falls back to a basename-unique match when knownPaths is provided and literal misses", () => {
    // chartbook/article.html was the inbound href when the target
    // lived there; the file has since moved to root. With knownPaths
    // provided, extraction should heal the link to root article.html.
    const html = `<a class="wikilink" href="./article.html">x</a>`;
    const known = new Set(["chartbook/index.html", "article.html"]);
    const out = extractHtmlLinks(html, "chartbook/index.html", known);
    expect(out).toHaveLength(1);
    expect(out[0]!.resolved).toBe("article.html");
  });

  it("keeps the literal resolution when basename is ambiguous", () => {
    // Two files share the basename — fallback can't pick, so the
    // anchor stays a redlink at the literal-resolved path.
    const html = `<a class="wikilink" href="./article.html">x</a>`;
    const known = new Set([
      "chartbook/index.html",
      "iarpa/article.html",
      "chartbook/article.html",
    ]);
    // Note: chartbook/article.html IS in known, so this is the
    // "literal hit" path. Use a different fromPath to force the
    // fallback consideration.
    const out = extractHtmlLinks(html, "missing/index.html", known);
    expect(out).toHaveLength(1);
    // literal-resolved is missing/article.html → ambiguous fallback
    // (two matches) → keep literal.
    expect(out[0]!.resolved).toBe("missing/article.html");
  });

  it("without knownPaths, behavior is the pre-change literal resolve", () => {
    const html = `<a class="wikilink" href="./article.html">x</a>`;
    const out = extractHtmlLinks(html, "chartbook/index.html");
    expect(out).toHaveLength(1);
    expect(out[0]!.resolved).toBe("chartbook/article.html");
  });
});
