// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure unit tests for the helpers in file-edits.ts that don't depend
 * on the filesystem or the SQLite index. Anything that requires
 * applyEdit to write a file and propagate via syncFile lives in
 * test/e2e/file-edits-modes.test.ts.
 */

import { describe, expect, it } from "vitest";

import { removeSection } from "../../src/server/lib/file-edits.js";

describe("removeSection", () => {
  it("removes a section through the next same-level heading", () => {
    const input = [
      "Lead paragraph.",
      "",
      "## Keep me",
      "",
      "Keep this body.",
      "",
      "## Drop me",
      "",
      "Drop this body.",
      "",
      "## Keep me too",
      "",
      "And this body.",
      "",
    ].join("\n");
    const out = removeSection(input, "## Drop me", "wiki/x.md");
    expect(out).not.toContain("Drop me");
    expect(out).not.toContain("Drop this body");
    expect(out).toContain("## Keep me");
    expect(out).toContain("Keep this body.");
    expect(out).toContain("## Keep me too");
    expect(out).toContain("And this body.");
  });

  it("removes a section through the next higher-level heading", () => {
    const input = [
      "# Top",
      "",
      "## Drop me",
      "",
      "Drop body.",
      "",
      "### A subsection that nests under Drop me",
      "",
      "Subsection body.",
      "",
      "# Another top",
      "",
      "Top-level body.",
    ].join("\n");
    const out = removeSection(input, "## Drop me", "wiki/x.md");
    expect(out).not.toContain("Drop me");
    expect(out).not.toContain("Drop body");
    expect(out).not.toContain("A subsection that nests");
    expect(out).toContain("# Top");
    expect(out).toContain("# Another top");
    expect(out).toContain("Top-level body.");
  });

  it("removes through EOF when no follower heading exists", () => {
    const input = [
      "Lead.",
      "",
      "## Final section",
      "",
      "Final body.",
      "",
    ].join("\n");
    const out = removeSection(input, "## Final section", "wiki/x.md");
    expect(out).toBe("Lead.\n\n");
  });

  it("level-discriminates on uniqueness — same text at different levels counts as different sections", () => {
    // `### Foo` and `## Foo` are different sections. Asking to delete
    // `### Foo` finds exactly one match (the H3) and removes only it,
    // leaving the H2 section intact. The H2 body is preserved verbatim.
    const input = [
      "## Foo",
      "",
      "h2 body line.",
      "",
      "### Foo",
      "",
      "h3 body line.",
      "",
      "## After",
      "",
      "after body.",
      "",
    ].join("\n");
    const out = removeSection(input, "### Foo", "wiki/x.md");
    expect(out).toContain("## Foo");
    expect(out).toContain("h2 body line.");
    expect(out).not.toContain("### Foo");
    expect(out).not.toContain("h3 body line.");
    expect(out).toContain("## After");
    expect(out).toContain("after body.");
  });

  it("removes nested subsections together with their parent heading", () => {
    // Deleting `## Drop` removes the H2 plus its nested H3 child — the
    // H3 is inside the H2's section by markdown convention. The next
    // same-or-higher heading (the `## Keep`) bounds the deletion.
    const input = [
      "## Drop",
      "",
      "drop body.",
      "",
      "### nested",
      "",
      "nested body.",
      "",
      "## Keep",
      "",
      "keep body.",
      "",
    ].join("\n");
    const out = removeSection(input, "## Drop", "wiki/x.md");
    expect(out).not.toContain("Drop");
    expect(out).not.toContain("nested");
    expect(out).toContain("## Keep");
    expect(out).toContain("keep body.");
  });

  it("ignores `#` lines inside a fenced code block", () => {
    const input = [
      "## Real heading",
      "",
      "```",
      "## Not a heading inside a fence",
      "```",
      "",
      "Body.",
      "",
    ].join("\n");
    const out = removeSection(input, "## Real heading", "wiki/x.md");
    // Everything from the real heading through EOF is gone.
    expect(out).toBe("");
  });

  it("treats fence-open lines as the toggle, not headings", () => {
    // The fence-tracker must not see the inner '## ...' as a heading
    // candidate for a different section's deletion.
    const input = [
      "## Outer",
      "",
      "Outer body.",
      "",
      "## Other",
      "",
      "```",
      "## Looks-like-h2",
      "```",
      "",
      "Other body.",
      "",
    ].join("\n");
    const out = removeSection(input, "## Other", "wiki/x.md");
    // The faux-heading inside the fence should not have been considered
    // as a follower of '## Other'.
    expect(out).toContain("## Outer");
    expect(out).toContain("Outer body.");
    expect(out).not.toContain("## Other");
    expect(out).not.toContain("Other body.");
    expect(out).not.toContain("Looks-like-h2");
  });

  it("throws when the heading is not present", () => {
    const input = "## Only one\n\nbody\n";
    expect(() =>
      removeSection(input, "## Missing", "wiki/x.md"),
    ).toThrow(/did not match/);
  });

  it("throws when the heading appears more than once at the same level", () => {
    const input = [
      "## Twin",
      "",
      "first",
      "",
      "## Twin",
      "",
      "second",
      "",
    ].join("\n");
    expect(() =>
      removeSection(input, "## Twin", "wiki/x.md"),
    ).toThrow(/matched 2 times/);
  });

  it("throws on a malformed heading spec", () => {
    expect(() =>
      removeSection("## A\n", "Open threads", "wiki/x.md"),
    ).toThrow(/ATX heading/);
  });
});
