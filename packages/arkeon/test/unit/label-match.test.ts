// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { buildCandidateQueries, normalizeLabel, strictNormalizeLabel } from "../../src/server/lib/label-match";

describe("normalizeLabel", () => {
  test("lowercases and collapses whitespace", () => {
    expect(normalizeLabel("  The  Nile   River  ")).toBe("nile river");
  });

  test("strips leading article", () => {
    expect(normalizeLabel("An Important Concept")).toBe("important concept");
    expect(normalizeLabel("A Book")).toBe("book");
  });

  test("strips honorific prefixes", () => {
    expect(normalizeLabel("Dr. Matt Connelly")).toBe("matt connelly");
    expect(normalizeLabel("Gen. Eisenhower")).toBe("eisenhower");
    expect(normalizeLabel("Secretary Kerry")).toBe("kerry");
  });

  test("makes two variants of the same name collide", () => {
    expect(normalizeLabel("The  BENGAL  framework"))
      .toBe(normalizeLabel("BENGAL framework"));
  });
});

describe("strictNormalizeLabel", () => {
  // Strict normalization is used for the exact-match short-circuit —
  // it must NOT consider labels equal if they differ by honorific,
  // article, or any other content word. Only case and whitespace
  // differences are treated as equivalent.

  test("collapses case and whitespace", () => {
    expect(strictNormalizeLabel("  William  Smith  ")).toBe("william smith");
    expect(strictNormalizeLabel("MATT CONNELLY")).toBe("matt connelly");
  });

  test("keeps honorifics — 'Dr. Smith' must NOT match 'Smith'", () => {
    expect(strictNormalizeLabel("Dr. Smith")).not.toBe(strictNormalizeLabel("Smith"));
    expect(strictNormalizeLabel("Dr. Smith")).toBe("dr. smith");
    expect(strictNormalizeLabel("Smith")).toBe("smith");
  });

  test("keeps articles — 'The Nile' must NOT match 'Nile'", () => {
    expect(strictNormalizeLabel("The Nile")).not.toBe(strictNormalizeLabel("Nile"));
    expect(strictNormalizeLabel("The Nile")).toBe("the nile");
    expect(strictNormalizeLabel("Nile")).toBe("nile");
  });

  test("keeps every content word — no token stripping", () => {
    expect(strictNormalizeLabel("Mercury (planet)")).toBe("mercury (planet)");
    expect(strictNormalizeLabel("William Smith Jr.")).not.toBe(strictNormalizeLabel("William Smith"));
  });

  test("collapses multi-space and case — two legitimate formatting variants match", () => {
    expect(strictNormalizeLabel("William Smith"))
      .toBe(strictNormalizeLabel("  william   smith"));
  });

  test("regression: original short-circuit bug where 'Smith' auto-matched 'Dr. Smith'", () => {
    // Under the looser normalizeLabel, these collapsed and incorrectly
    // short-circuited a resolve call. strictNormalizeLabel must not.
    expect(normalizeLabel("Dr. Smith")).toBe(normalizeLabel("Smith"));            // loose: same
    expect(strictNormalizeLabel("Dr. Smith")).not.toBe(strictNormalizeLabel("Smith")); // strict: different
  });
});

describe("buildCandidateQueries", () => {
  test("empty label returns empty set", () => {
    expect(buildCandidateQueries("")).toEqual([]);
  });

  test("single-word label produces one or two queries", () => {
    const queries = buildCandidateQueries("Connelly");
    expect(queries).toContain("Connelly");
    expect(queries).toContain("connelly");
  });

  test("multi-word label produces whole + per-word queries", () => {
    const queries = buildCandidateQueries("Matt Connelly");
    expect(queries).toContain("Matt Connelly");
    expect(queries).toContain("matt connelly");
    expect(queries).toContain("matt");
    expect(queries).toContain("connelly");
  });

  test("strips stop words from per-token queries", () => {
    const queries = buildCandidateQueries("The History of the Cold War");
    // Full raw + normalized (stop words stay in the phrase form)
    expect(queries).toContain("The History of the Cold War");
    expect(queries).toContain("history of the cold war");
    // But stop words should NOT show up as their own single-word query
    expect(queries).not.toContain("the");
    expect(queries).not.toContain("of");
    // Content words should
    expect(queries).toContain("history");
    expect(queries).toContain("cold");
    expect(queries).toContain("war");
  });

  test("short description adds phrase query", () => {
    const queries = buildCandidateQueries("BENGAL", "Classification framework");
    expect(queries).toContain("Classification framework");
    expect(queries).toContain("classification");
    expect(queries).toContain("framework");
  });

  test("very long description is not added as a phrase query", () => {
    const long = "A very long description that goes on and on about many " +
      "different aspects of the subject, covering historical context, " +
      "methodology, and outcomes, clearly exceeding the phrase length cap.";
    const queries = buildCandidateQueries("BENGAL", long);
    expect(queries).not.toContain(long);
    // But content words from it may still appear
    expect(queries).toContain("bengal");
  });

  test("caps total query count at 10", () => {
    const labelWithLots = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu";
    const queries = buildCandidateQueries(labelWithLots);
    expect(queries.length).toBeLessThanOrEqual(10);
  });

  test("drops 1-character content tokens", () => {
    const queries = buildCandidateQueries("A B Cat");
    // The full label is kept as-is, but per-token shouldn't include "a" or "b"
    expect(queries).not.toContain("a");
    expect(queries).not.toContain("b");
    expect(queries).toContain("cat");
  });

  test("includes author-provided keywords as their own queries", () => {
    const queries = buildCandidateQueries(
      "George Washington",
      "First president of the United States.",
      ["first president", "founding father", "Washington"],
    );
    expect(queries).toContain("first president");
    expect(queries).toContain("founding father");
    // Word-level tokens from the label are still there
    expect(queries).toContain("george");
    expect(queries).toContain("washington");
  });

  test("keywords contribute to the 10-query cap", () => {
    const queries = buildCandidateQueries(
      "Topic",
      undefined,
      ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10"],
    );
    expect(queries.length).toBeLessThanOrEqual(10);
  });
});
