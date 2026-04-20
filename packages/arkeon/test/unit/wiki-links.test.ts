// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { parseWikiLinks, WikiLinkParseError } from "../../src/server/lib/wiki-links";

describe("wiki link parsing", () => {
  test("parses typed links and demotes assign→placeholder at max depth", () => {
    const content = [
      "Known [[entity:01ARSKM3X5BCG9K7QJ4VZW6YE0]].",
      "Resolve [[resolve:\"Matt Connelly\"|\"Columbia historian\"]].",
      "Placeholder [[placeholder:\"Mosaic Theory\"|\"classification concept\"]].",
      "Assign [[assign:\"Open Concept\"|\"worker should draft\"]].",
    ].join(" ");

    const links = parseWikiLinks(content, 2, 2);

    // At depth >= maxDepth, assign is demoted to placeholder.
    expect(links.map((l) => l.type)).toEqual(["entity", "resolve", "placeholder", "placeholder"]);
    expect(links[0]!.id).toBe("01ARSKM3X5BCG9K7QJ4VZW6YE0");
    expect(links[1]!.label).toBe("Matt Connelly");
    expect(links[1]!.description).toBe("Columbia historian");
    expect(links[2]!.label).toBe("Mosaic Theory");
    expect(links[2]!.spanText).toContain("Placeholder");
    expect(links[3]!.label).toBe("Open Concept");
  });

  test("strips display label from entity links (LLM pipe syntax)", () => {
    const content = "See [[entity:01ARSKM3X5BCG9K7QJ4VZW6YE0|Renaissance Art]] for details.";
    const links = parseWikiLinks(content, 0, 2);
    expect(links).toHaveLength(1);
    expect(links[0]!.type).toBe("entity");
    expect(links[0]!.id).toBe("01ARSKM3X5BCG9K7QJ4VZW6YE0");
  });

  test("demotes entity link with label instead of ULID to resolve", () => {
    const content = "See [[entity:Renaissance Art]] for details.";
    const links = parseWikiLinks(content, 0, 2);
    expect(links).toHaveLength(1);
    expect(links[0]!.type).toBe("resolve");
    expect(links[0]!.label).toBe("Renaissance Art");
  });

  test("demotes single-word entity label (not a ULID) to resolve", () => {
    const content = "See [[entity:Michelangelo]] and [[entity:NATO]].";
    const links = parseWikiLinks(content, 0, 2);
    expect(links).toHaveLength(2);
    expect(links[0]!.type).toBe("resolve");
    expect(links[0]!.label).toBe("Michelangelo");
    expect(links[1]!.type).toBe("resolve");
    expect(links[1]!.label).toBe("NATO");
  });

  test("assign stays assign when depth below max", () => {
    const content = "Assign [[assign:\"Widget\"|\"to be drafted\"]].";
    const links = parseWikiLinks(content, 0, 2);
    expect(links).toHaveLength(1);
    expect(links[0]!.type).toBe("assign");
    expect(links[0]!.label).toBe("Widget");
  });

  test("accepts unquoted label and description in resolve/assign/placeholder links", () => {
    const content = [
      "Unquoted [[resolve:Unquoted Label|Some description here]].",
      "Mixed [[assign:\"Quoted Label\"|unquoted description]].",
      "Label only [[placeholder:Just A Label]].",
    ].join(" ");

    const links = parseWikiLinks(content, 0, 2);
    expect(links).toHaveLength(3);

    expect(links[0]!.type).toBe("resolve");
    expect(links[0]!.label).toBe("Unquoted Label");
    expect(links[0]!.description).toBe("Some description here");

    expect(links[1]!.type).toBe("assign");
    expect(links[1]!.label).toBe("Quoted Label");
    expect(links[1]!.description).toBe("unquoted description");

    expect(links[2]!.type).toBe("placeholder");
    expect(links[2]!.label).toBe("Just A Label");
    expect(links[2]!.description).toBeUndefined();
  });

  test("rejects bare and unknown-type wiki links with offsets", () => {
    const content = "Bad [[Some Page]] and [[unknown:\"Thing\"]].";

    expect(() => parseWikiLinks(content, 0, 2)).toThrow(WikiLinkParseError);

    try {
      parseWikiLinks(content, 0, 2);
    } catch (err) {
      expect(err).toBeInstanceOf(WikiLinkParseError);
      const details = (err as WikiLinkParseError).details;
      expect(details).toHaveLength(2);
      expect(details[0]!.raw).toBe("[[Some Page]]");
      expect(details[0]!.offset).toBe(content.indexOf("[[Some Page]]"));
      expect(details.map((d) => d.reason).join(" ")).toContain("typed link");
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
      expect(details[0]!.reason).toContain("Unclosed wiki link");
    }
  });
});
