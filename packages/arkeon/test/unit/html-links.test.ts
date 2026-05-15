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

  it("passes server-absolute paths through verbatim (canonical cross-space form)", () => {
    expect(resolveHref("/other-space/wiki/foo.html", "wiki/foo.html")).toBe(
      "/other-space/wiki/foo.html",
    );
  });

  it("strips fragment/query from server-absolute paths", () => {
    expect(resolveHref("/other/wiki/foo.html#bar", "wiki/foo.html")).toBe(
      "/other/wiki/foo.html",
    );
    expect(resolveHref("/other/wiki/foo.html?v=1", "wiki/foo.html")).toBe(
      "/other/wiki/foo.html",
    );
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

  describe("with cross-space resolution opts", () => {
    const opts = {
      thisSpaceName: "primary",
      thisWatchDir: "/tmp/primary",
      spaces: new Map<string, string>([
        ["primary", "/tmp/primary"],
        ["other", "/tmp/work/other"],
      ]),
    };

    it("rewrites a filesystem-relative escape into another space to canonical form", () => {
      // Article at /tmp/primary/wiki/foo.html, target at
      // /tmp/work/other/wiki/bar.html → relative is
      // ../../work/other/wiki/bar.html, which lands in space `other`.
      expect(
        resolveHref("../../work/other/wiki/bar.html", "wiki/foo.html", opts),
      ).toBe("/other/wiki/bar.html");
    });

    it("still drops escapes that don't land in any registered space", () => {
      expect(
        resolveHref("../../etc/passwd", "wiki/foo.html", opts),
      ).toBeNull();
    });

    it("leaves in-space resolution unchanged when opts are supplied", () => {
      expect(resolveHref("other.html", "wiki/foo.html", opts)).toBe(
        "wiki/other.html",
      );
    });
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
