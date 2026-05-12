// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import { composeWikiHtmlShell, safeResolve } from "../../src/server/lib/file-edits.js";

describe("safeResolve", () => {
  it("resolves a relative path under the watch dir", () => {
    const abs = safeResolve("/tmp/space", "wiki/foo.html");
    expect(abs).toBe("/tmp/space/wiki/foo.html");
  });

  it("rejects absolute paths", () => {
    expect(() => safeResolve("/tmp/space", "/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects paths that escape the watch dir", () => {
    expect(() => safeResolve("/tmp/space", "../escape")).toThrow(/escapes/);
    expect(() => safeResolve("/tmp/space", "wiki/../../escape")).toThrow(/escapes/);
  });

  it("rejects paths containing NUL bytes", () => {
    expect(() => safeResolve("/tmp/space", "foo\0.html")).toThrow(/NUL/);
  });
});

describe("composeWikiHtmlShell", () => {
  it("emits a well-formed HTML document with charset, title, and meta tags", () => {
    const html = composeWikiHtmlShell({
      label: "Photosynthesis",
      short_description: "How plants convert light.",
      body: "<h1>Photosynthesis</h1><p>Hi.</p>",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(`<meta charset="utf-8">`);
    expect(html).toContain("<title>Photosynthesis</title>");
    expect(html).toContain(`<meta name="label" content="Photosynthesis">`);
    expect(html).toContain(`<meta name="short_description" content="How plants convert light.">`);
    expect(html).toContain("<h1>Photosynthesis</h1><p>Hi.</p>");
  });

  it("places <meta charset> within the first 1024 bytes (HTML5 requirement)", () => {
    const html = composeWikiHtmlShell({
      label: "X",
      short_description: "y",
      body: "<h1>x</h1>",
    });
    const charsetPos = html.indexOf(`<meta charset="utf-8">`);
    expect(charsetPos).toBeGreaterThan(-1);
    expect(charsetPos).toBeLessThan(1024);
  });

  it("escapes ampersands and quotes in attribute values", () => {
    const html = composeWikiHtmlShell({
      label: `Cats & "Dogs"`,
      short_description: "x",
      body: "<h1>x</h1>",
    });
    expect(html).toContain(`<title>Cats &amp; &quot;Dogs&quot;</title>`);
    expect(html).toContain(`<meta name="label" content="Cats &amp; &quot;Dogs&quot;">`);
  });

  it("emits extra meta tags from the `extra` map", () => {
    const html = composeWikiHtmlShell({
      label: "X",
      short_description: "y",
      body: "<h1>X</h1>",
      extra: { author: "shannon", year: "1948" },
    });
    expect(html).toContain(`<meta name="author" content="shannon">`);
    expect(html).toContain(`<meta name="year" content="1948">`);
  });

  it("ignores extra entries that conflict with built-ins (label / short_description)", () => {
    const html = composeWikiHtmlShell({
      label: "Real",
      short_description: "real",
      body: "<h1>x</h1>",
      extra: { label: "fake", author: "shannon" },
    });
    expect(html.match(/name="label"/g)).toHaveLength(1);
    expect(html).toContain(`<meta name="label" content="Real">`);
    expect(html).toContain(`<meta name="author" content="shannon">`);
  });

  it("rejects bodies that include shell tags (defence against prompt drift)", () => {
    const cases = [
      "<html><body>x</body></html>",
      "<!DOCTYPE html><h1>x</h1>",
      "<h1>x</h1></body>",
      "<head><meta name=evil></head>",
      "<title>sneaky</title>",
      "<META name=author>", // case-insensitive
    ];
    for (const body of cases) {
      expect(() =>
        composeWikiHtmlShell({ label: "x", short_description: "y", body }),
      ).toThrow(/body contains a shell tag/);
    }
  });

  it("accepts ordinary content tags in body", () => {
    const html = composeWikiHtmlShell({
      label: "x",
      short_description: "y",
      body: `<h1>X</h1><p>Text with <a href="other.html">link</a> and <em>emphasis</em>.</p>`,
    });
    expect(html).toContain("<h1>X</h1>");
  });
});
