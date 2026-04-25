// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { extractMarkdownLinks, resolveRelativeLink } from "../../src/server/lib/markdown-links.js";

describe("extractMarkdownLinks", () => {
  it("extracts basic markdown links to .md files", () => {
    const content = "He worked at [Bell Labs](../organization/bell-labs.md).";
    const links = extractMarkdownLinks(content);
    expect(links).toEqual([{ text: "Bell Labs", path: "../organization/bell-labs.md" }]);
  });

  it("extracts multiple links", () => {
    const content = `
He worked at [Bell Labs](../organization/bell-labs.md) on
[information theory](../concept/information-theory.md).
`;
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0].text).toBe("Bell Labs");
    expect(links[1].text).toBe("information theory");
  });

  it("ignores HTTP links", () => {
    const content = "Visit [Google](https://google.com) and [local](test.md).";
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("local");
  });

  it("ignores image links", () => {
    const content = "![image](photo.md) and [link](real.md).";
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("link");
  });

  it("ignores non-.md links", () => {
    const content = "[pdf](doc.pdf) and [wiki](page.md).";
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("wiki");
  });

  it("ignores anchor-only links", () => {
    const content = "[section](#heading) and [wiki](page.md).";
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
  });

  it("strips anchor fragments from paths", () => {
    const content = "[section](page.md#heading).";
    const links = extractMarkdownLinks(content);
    expect(links[0].path).toBe("page.md");
  });

  it("handles links in same directory", () => {
    const content = "[sibling](sibling.md).";
    const links = extractMarkdownLinks(content);
    expect(links[0].path).toBe("sibling.md");
  });

  it("returns empty array for no links", () => {
    const content = "Just plain text with no links.";
    const links = extractMarkdownLinks(content);
    expect(links).toEqual([]);
  });

  it("handles links with spaces in text", () => {
    const content = "[Claude Elwood Shannon](claude-shannon.md).";
    const links = extractMarkdownLinks(content);
    expect(links[0].text).toBe("Claude Elwood Shannon");
  });
});

describe("resolveRelativeLink", () => {
  it("resolves parent directory reference", () => {
    const result = resolveRelativeLink("wiki/person/claude-shannon.md", "../organization/bell-labs.md");
    expect(result).toBe("wiki/organization/bell-labs.md");
  });

  it("resolves sibling file in same directory", () => {
    const result = resolveRelativeLink("wiki/person/claude-shannon.md", "alan-turing.md");
    expect(result).toBe("wiki/person/alan-turing.md");
  });

  it("resolves deeply nested relative path", () => {
    const result = resolveRelativeLink("wiki/science/physics/quantum.md", "../../math/algebra.md");
    expect(result).toBe("wiki/math/algebra.md");
  });

  it("resolves current directory reference", () => {
    const result = resolveRelativeLink("wiki/person/test.md", "./other.md");
    expect(result).toBe("wiki/person/other.md");
  });

  it("handles root-level files", () => {
    const result = resolveRelativeLink("readme.md", "other.md");
    expect(result).toBe("other.md");
  });

  it("handles deeply nested target", () => {
    const result = resolveRelativeLink("wiki/person/test.md", "../concept/sub/deep.md");
    expect(result).toBe("wiki/concept/sub/deep.md");
  });
});
