// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  extractMarkdownLinks,
  extractWikiLinks,
  resolveRelativeLink,
} from "../../src/server/lib/markdown-links.js";

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

  it("does not pick up [[wikilink]] syntax", () => {
    const content =
      "Here are [[Bell Labs]] and [Shannon](shannon.md) and [[Foo|person]].";
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("Shannon");
  });
});

describe("extractWikiLinks", () => {
  it("extracts a bare wikilink", () => {
    const links = extractWikiLinks("See [[Bell Labs]] for context.");
    expect(links).toEqual([{ label: "Bell Labs" }]);
  });

  it("extracts a typed wikilink", () => {
    const links = extractWikiLinks("[[Claude Shannon|person]] worked there.");
    expect(links).toEqual([{ label: "Claude Shannon", subject_type: "person" }]);
  });

  it("extracts multiple wikilinks of mixed forms", () => {
    const content =
      "[[Information Theory]] grew from [[Claude Shannon|person]]'s work " +
      "at [[Bell Labs|organization]].";
    const links = extractWikiLinks(content);
    expect(links).toEqual([
      { label: "Information Theory" },
      { label: "Claude Shannon", subject_type: "person" },
      { label: "Bell Labs", subject_type: "organization" },
    ]);
  });

  it("trims whitespace around label and subject_type", () => {
    const links = extractWikiLinks("[[  Bell Labs  |  organization  ]]");
    expect(links).toEqual([
      { label: "Bell Labs", subject_type: "organization" },
    ]);
  });

  it("skips empty labels", () => {
    const links = extractWikiLinks("[[]] and [[   ]] and [[ |person]]");
    expect(links).toEqual([]);
  });

  it("ignores malformed multi-pipe forms", () => {
    const links = extractWikiLinks("[[Foo|a|b]] and [[Bar]]");
    expect(links).toEqual([{ label: "Bar" }]);
  });

  it("does not pick up standard markdown links", () => {
    const links = extractWikiLinks(
      "[Shannon](shannon.md) and [Bell Labs](../org/bell.md)",
    );
    expect(links).toEqual([]);
  });

  it("does not match links nested in standard markdown link text", () => {
    // [[Label] inside [text](path) — the `[` after `[Label` doesn't
    // satisfy the wikilink regex's `]]` closer.
    const links = extractWikiLinks("[[Label](path.md)");
    expect(links).toEqual([]);
  });

  it("returns empty array for no wikilinks", () => {
    expect(extractWikiLinks("Just plain text.")).toEqual([]);
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

  // ── workspace-rooted form: paths starting with "/" ──────────────
  it("resolves workspace-rooted link from a wiki file", () => {
    const result = resolveRelativeLink(
      "wiki/person/claude-shannon.md",
      "/wiki/organization/bell-labs.md",
    );
    expect(result).toBe("wiki/organization/bell-labs.md");
  });

  it("resolves workspace-rooted link to a non-wiki file (sources)", () => {
    // This is the case the dot-relative form gets wrong (../sources/x
    // from wiki/<type>/<slug>.md should be ../../sources/x, two ups).
    // The workspace-rooted form sidesteps the depth count entirely.
    const result = resolveRelativeLink(
      "wiki/concept/baptism.md",
      "/sources/book-01-i.md",
    );
    expect(result).toBe("sources/book-01-i.md");
  });

  it("resolves workspace-rooted link the same regardless of source depth", () => {
    // Same target reached from a shallow file and a deeply-nested one.
    expect(
      resolveRelativeLink("wiki/person/x.md", "/wiki/concept/y.md"),
    ).toBe("wiki/concept/y.md");
    expect(
      resolveRelativeLink(
        "wiki/person/saints/early-fathers/x.md",
        "/wiki/concept/y.md",
      ),
    ).toBe("wiki/concept/y.md");
  });

  it("normalizes redundant segments in workspace-rooted paths", () => {
    expect(
      resolveRelativeLink("wiki/person/x.md", "/wiki/./person/../concept/y.md"),
    ).toBe("wiki/concept/y.md");
  });
});
