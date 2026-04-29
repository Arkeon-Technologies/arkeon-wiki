// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { chunkWiki } from "../../src/server/lib/chunker.js";
import type { ParsedWiki } from "../../src/server/lib/frontmatter.js";

function wiki(properties: Record<string, unknown>, body: string): ParsedWiki {
  return { properties, body };
}

describe("chunker — card composition", () => {
  it("emits a card chunk with just the label when nothing else is present", () => {
    const chunks = chunkWiki(wiki({}, ""), "Claude Shannon");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_kind).toBe("card");
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].heading_path).toBe("Claude Shannon");
    expect(chunks[0].text).toBe("Claude Shannon");
    expect(chunks[0].start_line).toBeNull();
    expect(chunks[0].end_line).toBeNull();
  });

  it("includes subject_type in parentheses on the first line", () => {
    const chunks = chunkWiki(
      wiki({ subject_type: "person" }, ""),
      "Claude Shannon",
    );
    expect(chunks[0].text.split("\n")[0]).toBe("Claude Shannon (person)");
  });

  it("includes aliases line when present and non-empty", () => {
    const chunks = chunkWiki(
      wiki({ subject_type: "person", aliases: ["Shannon", "C. E. Shannon"] }, ""),
      "Claude Shannon",
    );
    expect(chunks[0].text).toContain("Aliases: Shannon, C. E. Shannon");
  });

  it("ignores empty aliases and non-string entries", () => {
    const chunks = chunkWiki(
      wiki({ aliases: ["", "  ", 42, "Shannon"] }, ""),
      "Claude Shannon",
    );
    expect(chunks[0].text).toContain("Aliases: Shannon");
  });

  it("omits the aliases line when the field is missing or empty", () => {
    const chunks = chunkWiki(wiki({ aliases: [] }, ""), "Claude Shannon");
    expect(chunks[0].text).not.toContain("Aliases:");
  });

  it("includes short_description when present", () => {
    const chunks = chunkWiki(
      wiki({ short_description: "Father of information theory." }, ""),
      "Claude Shannon",
    );
    expect(chunks[0].text).toContain("Father of information theory.");
  });

  it("includes the lead paragraph (text before the first H2) on the card", () => {
    const body = "Claude Shannon was an American mathematician.\n\n## Early Life\n\nBorn in Michigan.";
    const chunks = chunkWiki(wiki({}, body), "Claude Shannon");

    const card = chunks.find((c) => c.chunk_kind === "card")!;
    expect(card.text).toContain("Claude Shannon was an American mathematician.");
    expect(card.text).not.toContain("Born in Michigan");
  });
});

describe("chunker — section chunks", () => {
  const body = [
    "Lead paragraph for the wiki.",
    "",
    "## Early Life",
    "",
    "Shannon was born in 1916 in Michigan.",
    "",
    "## Career",
    "",
    "Worked at Bell Labs.",
  ].join("\n");

  it("emits one chunk per non-empty H2 section", () => {
    const chunks = chunkWiki(wiki({}, body), "Claude Shannon");
    const sections = chunks.filter((c) => c.chunk_kind === "section");
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.heading_path)).toEqual([
      "Claude Shannon > Early Life",
      "Claude Shannon > Career",
    ]);
  });

  it("prepends the heading path to the section body in chunk text", () => {
    const chunks = chunkWiki(wiki({}, body), "Claude Shannon");
    const earlyLife = chunks.find((c) => c.heading_path === "Claude Shannon > Early Life")!;
    expect(earlyLife.text.startsWith("Claude Shannon > Early Life\n\n")).toBe(true);
    expect(earlyLife.text).toContain("Shannon was born in 1916 in Michigan.");
  });

  it("assigns sequential chunk_index starting from 0 (card first)", () => {
    const chunks = chunkWiki(wiki({}, body), "Claude Shannon");
    expect(chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2]);
    expect(chunks[0].chunk_kind).toBe("card");
  });

  it("skips heading-only sections (no body)", () => {
    const empty = "## Section A\n\nA has content.\n\n## Section B\n\n## Section C\n\nC has content.";
    const chunks = chunkWiki(wiki({}, empty), "Wiki");
    const sectionLabels = chunks
      .filter((c) => c.chunk_kind === "section")
      .map((c) => c.heading_path);
    expect(sectionLabels).toEqual(["Wiki > Section A", "Wiki > Section C"]);
  });

  it("absorbs H3 sub-sections into the parent H2 chunk when small enough", () => {
    const nested = [
      "## Career",
      "",
      "Overview of his career.",
      "",
      "### Bell Labs",
      "",
      "Joined in 1941.",
      "",
      "### MIT",
      "",
      "Returned in 1956.",
    ].join("\n");

    const chunks = chunkWiki(wiki({}, nested), "Claude Shannon");
    const sections = chunks.filter((c) => c.chunk_kind === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading_path).toBe("Claude Shannon > Career");
    expect(sections[0].text).toContain("Overview of his career.");
    expect(sections[0].text).toContain("### Bell Labs");
    expect(sections[0].text).toContain("Joined in 1941.");
    expect(sections[0].text).toContain("### MIT");
  });

  it("returns no section chunks when the body has no H2", () => {
    const chunks = chunkWiki(wiki({}, "Just some prose."), "Wiki");
    expect(chunks.filter((c) => c.chunk_kind === "section")).toHaveLength(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_kind).toBe("card");
  });

  it("populates start_line and end_line for section chunks", () => {
    const chunks = chunkWiki(wiki({}, body), "Claude Shannon");
    const earlyLife = chunks.find((c) => c.heading_path === "Claude Shannon > Early Life")!;
    expect(typeof earlyLife.start_line).toBe("number");
    expect(typeof earlyLife.end_line).toBe("number");
    expect(earlyLife.start_line!).toBeGreaterThan(0);
  });
});

describe("chunker — heading sanitization", () => {
  it("strips bold/italic markers from heading text", () => {
    const body = "## **Bold** and *italic*\n\nBody.";
    const chunks = chunkWiki(wiki({}, body), "Wiki");
    const section = chunks.find((c) => c.chunk_kind === "section")!;
    expect(section.heading_path).toBe("Wiki > Bold and italic");
  });

  it("strips trailing attribute blocks", () => {
    const body = "## Heading {.special-class}\n\nBody.";
    const chunks = chunkWiki(wiki({}, body), "Wiki");
    expect(chunks.find((c) => c.chunk_kind === "section")!.heading_path)
      .toBe("Wiki > Heading");
  });

  it("ignores `##` lines inside fenced code blocks", () => {
    const body = [
      "Lead.",
      "",
      "```",
      "## not a real heading",
      "```",
      "",
      "## Real Section",
      "",
      "Real body.",
    ].join("\n");

    const chunks = chunkWiki(wiki({}, body), "Wiki");
    const sections = chunks.filter((c) => c.chunk_kind === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading_path).toBe("Wiki > Real Section");
  });

  it("preserves unicode in headings", () => {
    const body = "## Café Society\n\nBody.";
    const chunks = chunkWiki(wiki({}, body), "Wiki");
    expect(chunks.find((c) => c.chunk_kind === "section")!.heading_path)
      .toBe("Wiki > Café Society");
  });
});

describe("chunker — content_hash", () => {
  it("is the sha256 of the chunk text", () => {
    const chunks = chunkWiki(wiki({}, "## Section\n\nBody."), "Wiki");
    for (const c of chunks) {
      const expected = createHash("sha256").update(c.text).digest("hex");
      expect(c.content_hash).toBe(expected);
    }
  });

  it("is stable across runs for identical input", () => {
    const a = chunkWiki(wiki({ subject_type: "person" }, "## A\n\nB."), "X");
    const b = chunkWiki(wiki({ subject_type: "person" }, "## A\n\nB."), "X");
    expect(a.map((c) => c.content_hash)).toEqual(b.map((c) => c.content_hash));
  });

  it("changes when the wiki body changes", () => {
    const a = chunkWiki(wiki({}, "## A\n\nFirst."), "X");
    const b = chunkWiki(wiki({}, "## A\n\nSecond."), "X");
    const aSection = a.find((c) => c.chunk_kind === "section")!;
    const bSection = b.find((c) => c.chunk_kind === "section")!;
    expect(aSection.content_hash).not.toBe(bSection.content_hash);
  });
});

describe("chunker — oversized section fallback", () => {
  // Build a section large enough to trip the 1500-token budget. Each
  // paragraph is ~60 tokens; 30 paragraphs ≈ 1800 tokens.
  function bigSection(numParas: number, paraTokens: number): string {
    const word = "lorem ";
    const para = word.repeat(paraTokens).trim();
    const paras = Array.from({ length: numParas }, (_, i) => `${para} para${i}`);
    return `## Big\n\n${paras.join("\n\n")}`;
  }

  it("splits an oversized section into section_part chunks", () => {
    const chunks = chunkWiki(wiki({}, bigSection(30, 60)), "Wiki");
    const parts = chunks.filter((c) => c.chunk_kind === "section_part");
    expect(parts.length).toBeGreaterThan(1);

    for (const p of parts) {
      expect(p.heading_path).toBe("Wiki > Big");
      expect(p.text.startsWith("Wiki > Big\n\n")).toBe(true);
    }
  });

  it("emits no section chunk when the section was split (only section_part)", () => {
    const chunks = chunkWiki(wiki({}, bigSection(30, 60)), "Wiki");
    expect(chunks.find(
      (c) => c.chunk_kind === "section" && c.heading_path === "Wiki > Big",
    )).toBeUndefined();
  });

  it("preserves overlap between adjacent section_parts", () => {
    const chunks = chunkWiki(wiki({}, bigSection(30, 60)), "Wiki");
    const parts = chunks.filter((c) => c.chunk_kind === "section_part");
    expect(parts.length).toBeGreaterThanOrEqual(2);

    // The last paragraph of part N should also appear at the start of
    // part N+1 (after the heading_path prefix). We only check that some
    // overlap exists — the carryover is bounded by OVERLAP_TOKENS.
    const tailOfFirst = parts[0].text.split("\n\n").slice(-1)[0];
    expect(parts[1].text).toContain(tailOfFirst);
  });

  it("splits an oversized H3 with its own heading path", () => {
    const word = "lorem ".repeat(60).trim();
    const paras = Array.from({ length: 30 }, (_, i) => `${word} p${i}`).join("\n\n");
    const body = `## Career\n\nShort intro.\n\n### Bell Labs\n\n${paras}`;

    const chunks = chunkWiki(wiki({}, body), "Wiki");
    const partPaths = chunks
      .filter((c) => c.chunk_kind === "section_part")
      .map((c) => c.heading_path);

    expect(partPaths.some((p) => p === "Wiki > Career > Bell Labs")).toBe(true);
  });
});

describe("chunker — full integration shape", () => {
  it("produces a deterministic chunk list for a realistic wiki", () => {
    const props = {
      label: "Claude Shannon",
      subject_type: "person",
      aliases: ["C. E. Shannon"],
      short_description: "American mathematician, father of information theory.",
    };
    const body = [
      "Claude Shannon was an American mathematician and electrical engineer.",
      "",
      "## Early Life",
      "",
      "Born in 1916 in Petoskey, Michigan.",
      "",
      "## Career",
      "",
      "Joined Bell Labs in 1941.",
      "",
      "### Information Theory",
      "",
      "Published *A Mathematical Theory of Communication* in 1948.",
    ].join("\n");

    const chunks = chunkWiki(wiki(props, body), "Claude Shannon");

    expect(chunks.map((c) => c.chunk_kind)).toEqual(["card", "section", "section"]);
    expect(chunks.map((c) => c.heading_path)).toEqual([
      "Claude Shannon",
      "Claude Shannon > Early Life",
      "Claude Shannon > Career",
    ]);

    const card = chunks[0];
    expect(card.text).toContain("Claude Shannon (person)");
    expect(card.text).toContain("Aliases: C. E. Shannon");
    expect(card.text).toContain("father of information theory");
    expect(card.text).toContain("American mathematician and electrical engineer");

    const career = chunks[2];
    expect(career.text).toContain("Joined Bell Labs in 1941.");
    expect(career.text).toContain("### Information Theory");
    expect(career.text).toContain("A Mathematical Theory of Communication");
  });
});
