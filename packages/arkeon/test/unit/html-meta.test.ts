// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import { parseHtmlMeta } from "../../src/server/lib/html-meta.js";

describe("parseHtmlMeta", () => {
  it("extracts <title> and <meta name>/content pairs", () => {
    const html = `<!doctype html>
<title>Photosynthesis</title>
<meta name="label" content="Photosynthesis">
<meta name="short_description" content="How plants convert light.">
<body><h1>Photosynthesis</h1></body>`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("Photosynthesis");
    expect(result.properties).toEqual({
      label: "Photosynthesis",
      short_description: "How plants convert light.",
    });
  });

  it("returns null title when missing", () => {
    expect(parseHtmlMeta("<p>no head</p>").title).toBeNull();
  });

  it("ignores meta tags without a name (charset, http-equiv)", () => {
    const html = `<title>X</title>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="label" content="X">`;
    expect(parseHtmlMeta(html).properties).toEqual({ label: "X" });
  });

  it("handles apostrophes inside double-quoted content (real parser, not regex)", () => {
    const html = `<title>O'Reilly</title>
<meta name="short_description" content="Tim O'Reilly's tech publisher">`;
    const result = parseHtmlMeta(html);
    expect(result.title).toBe("O'Reilly");
    expect(result.properties.short_description).toBe("Tim O'Reilly's tech publisher");
  });

  it("trims whitespace from the title", () => {
    const html = `<title>
      Photosynthesis
    </title>`;
    expect(parseHtmlMeta(html).title).toBe("Photosynthesis");
  });

  it("only takes the first title", () => {
    const html = `<title>First</title><title>Second</title>`;
    expect(parseHtmlMeta(html).title).toBe("First");
  });
});
