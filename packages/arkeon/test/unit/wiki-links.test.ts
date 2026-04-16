// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { parseWikiLinks, WikiLinkParseError } from "../../src/server/lib/wiki-links";

describe("wiki link parsing", () => {
  test("parses typed links and promotes draft links at max depth", () => {
    const content = [
      "Known [[entity:01ABC_def-123]].",
      "Resolve [[resolve:\"Matt Connelly\"|\"Columbia historian\"]].",
      "Draft [[draft:\"Mosaic Theory\"|\"classification concept\"]].",
      "Gap [[gap:\"Open Concept\"|\"not expanded\"]].",
    ].join(" ");

    const links = parseWikiLinks(content, 2, 2);

    expect(links.map((l) => l.type)).toEqual(["entity", "resolve", "gap", "gap"]);
    expect(links[0]!.id).toBe("01ABC_def-123");
    expect(links[1]!.label).toBe("Matt Connelly");
    expect(links[1]!.description).toBe("Columbia historian");
    expect(links[2]!.label).toBe("Mosaic Theory");
    expect(links[2]!.spanText).toContain("Draft");
  });

  test("rejects bare and malformed wiki links with offsets", () => {
    const content = "Bad [[Some Page]] and [[resolve:Unquoted]] and [[unknown:\"Thing\"]].";

    expect(() => parseWikiLinks(content, 0, 2)).toThrow(WikiLinkParseError);

    try {
      parseWikiLinks(content, 0, 2);
    } catch (err) {
      expect(err).toBeInstanceOf(WikiLinkParseError);
      const details = (err as WikiLinkParseError).details;
      expect(details).toHaveLength(3);
      expect(details[0]!.raw).toBe("[[Some Page]]");
      expect(details[0]!.offset).toBe(content.indexOf("[[Some Page]]"));
      expect(details.map((d) => d.reason).join(" ")).toContain("typed link syntax");
      expect(details.map((d) => d.reason).join(" ")).toContain("quoted syntax");
      expect(details.map((d) => d.reason).join(" ")).toContain("Unknown wiki link type");
    }
  });

  test("rejects unclosed wiki links", () => {
    const content = "This has [[resolve:\"Missing close\"";

    expect(() => parseWikiLinks(content, 0, 2)).toThrow(WikiLinkParseError);

    try {
      parseWikiLinks(content, 0, 2);
    } catch (err) {
      const details = (err as WikiLinkParseError).details;
      expect(details).toHaveLength(1);
      expect(details[0]!.offset).toBe(content.indexOf("[["));
      expect(details[0]!.reason).toBe("Unclosed wiki link");
    }
  });
});
