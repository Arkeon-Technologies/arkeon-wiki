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

  it("drops server-absolute paths (reserved for v0.5 cross-space)", () => {
    expect(resolveHref("/other-space/wiki/foo.html", "wiki/foo.html")).toBeNull();
  });

  it("drops pure fragments", () => {
    expect(resolveHref("#section", "wiki/foo.html")).toBeNull();
  });

  it("drops paths that escape the space root", () => {
    expect(resolveHref("../../etc/passwd", "wiki/foo.html")).toBeNull();
    expect(resolveHref("../../../foo", "wiki/biology/x.html")).toBeNull();
  });
});

describe("extractHtmlLinks", () => {
  it("walks every <a href> in an HTML body", () => {
    const html = `<!doctype html><title>X</title>
<body>
  <p>
    See <a href="other.html">other</a> and
    <a href="../sources/p.md">paper</a>, plus
    <a href="https://en.wikipedia.org/x">external</a>.
  </p>
  <a href="biology/chlorophyll.html">chlorophyll</a>
</body>`;
    const links = extractHtmlLinks(html, "wiki/foo.html");
    expect(links).toHaveLength(4);

    const resolved = links.filter((l) => l.resolved !== null);
    expect(resolved.map((l) => ({ resolved: l.resolved, text: l.text }))).toEqual([
      { resolved: "wiki/other.html", text: "other" },
      { resolved: "sources/p.md", text: "paper" },
      { resolved: "wiki/biology/chlorophyll.html", text: "chlorophyll" },
    ]);

    const external = links.find((l) => l.href.startsWith("https://"));
    expect(external?.resolved).toBeNull();
  });

  it("returns empty array for HTML without anchors", () => {
    expect(extractHtmlLinks("<p>no links</p>", "wiki/foo.html")).toEqual([]);
  });

  it("skips anchors without an href attribute", () => {
    const html = `<a>no-href</a><a href="x.html">x</a>`;
    const links = extractHtmlLinks(html, "wiki/foo.html");
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("x");
  });
});
