// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  MAX_QUERY_PATTERNS,
  parseRipgrepJson,
  searchKeyword,
} from "../../src/server/lib/search.js";

const beginEvent = (path: string) =>
  JSON.stringify({ type: "begin", data: { path: { text: path } } });

const matchEvent = (
  path: string,
  lineNumber: number,
  lineText: string,
  matchText: string,
) =>
  JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${lineText}\n` },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [{ match: { text: matchText }, start: 0, end: matchText.length }],
    },
  });

const endEvent = (path: string, matchedLines: number) =>
  JSON.stringify({
    type: "end",
    data: {
      path: { text: path },
      binary_offset: null,
      stats: {
        elapsed: { secs: 0, nanos: 1, human: "0s" },
        searches: 1,
        searches_with_match: 1,
        bytes_searched: 100,
        bytes_printed: 50,
        matched_lines: matchedLines,
        matches: matchedLines,
      },
    },
  });

describe("parseRipgrepJson", () => {
  it("parses a single-file match stream", () => {
    const stdout = [
      beginEvent("wiki/foo.md"),
      matchEvent("wiki/foo.md", 3, "Alan Turing was a mathematician.", "Turing"),
      matchEvent("wiki/foo.md", 7, "Alan Turing later moved to Bell Labs.", "Turing"),
      endEvent("wiki/foo.md", 2),
      "",
    ].join("\n");

    const result = parseRipgrepJson(stdout, 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: "wiki/foo.md",
      match_count: 2,
    });
    expect(result[0]!.snippets).toHaveLength(2);
    expect(result[0]!.snippets[0]).toEqual({
      line_number: 3,
      text: "Alan Turing was a mathematician.",
    });
  });

  it("strips a leading './' from paths", () => {
    const stdout = [
      matchEvent("./wiki/foo.md", 1, "hello", "hello"),
      endEvent("./wiki/foo.md", 1),
    ].join("\n");

    const result = parseRipgrepJson(stdout, 3);
    expect(result[0]!.path).toBe("wiki/foo.md");
  });

  it("caps snippets at maxSnippetsPerFile but keeps full match count", () => {
    const lines = [beginEvent("a.md")];
    for (let i = 1; i <= 10; i++) {
      lines.push(matchEvent("a.md", i, `line ${i} matches`, "matches"));
    }
    lines.push(endEvent("a.md", 10));

    const result = parseRipgrepJson(lines.join("\n"), 3);
    expect(result[0]!.snippets).toHaveLength(3);
    expect(result[0]!.match_count).toBe(10);
  });

  it("groups matches across multiple files", () => {
    const stdout = [
      matchEvent("a.md", 1, "alpha", "alpha"),
      endEvent("a.md", 1),
      matchEvent("b.md", 5, "beta", "beta"),
      matchEvent("b.md", 6, "beta again", "beta"),
      endEvent("b.md", 2),
    ].join("\n");

    const result = parseRipgrepJson(stdout, 5);
    expect(result).toHaveLength(2);
    const byPath = Object.fromEntries(result.map((r) => [r.path, r]));
    expect(byPath["a.md"]!.match_count).toBe(1);
    expect(byPath["b.md"]!.match_count).toBe(2);
  });

  it("returns an empty array for empty input", () => {
    expect(parseRipgrepJson("", 3)).toEqual([]);
  });

  it("ignores malformed JSON lines without throwing", () => {
    const stdout = [
      "not json",
      matchEvent("a.md", 1, "hello", "hello"),
      "{not really json",
      endEvent("a.md", 1),
    ].join("\n");

    const result = parseRipgrepJson(stdout, 3);
    expect(result).toHaveLength(1);
    expect(result[0]!.match_count).toBe(1);
  });

  it("truncates very long snippet lines", () => {
    const longLine = "x".repeat(500) + "needle" + "y".repeat(500);
    const stdout = [
      matchEvent("a.md", 1, longLine, "needle"),
      endEvent("a.md", 1),
    ].join("\n");

    const result = parseRipgrepJson(stdout, 3);
    expect(result[0]!.snippets[0]!.text.length).toBeLessThanOrEqual(241);
    expect(result[0]!.snippets[0]!.text.endsWith("…")).toBe(true);
  });
});

// Defensive cap on multi-query inputs (#100). The route rejects
// oversized arrays at the boundary; this test pins the lib's own
// safety net for any future internal caller that bypasses the route.
describe("searchKeyword — input validation", () => {
  it("throws when query is an empty array", async () => {
    await expect(searchKeyword({ query: [] })).rejects.toThrow(/empty/i);
  });

  it(`throws when query has more than ${MAX_QUERY_PATTERNS} patterns`, async () => {
    const queries = Array.from(
      { length: MAX_QUERY_PATTERNS + 1 },
      (_, i) => `p${i}`,
    );
    await expect(searchKeyword({ query: queries })).rejects.toThrow(
      /too many query patterns/i,
    );
  });
});
