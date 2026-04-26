// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "../../src/server/lib/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses valid YAML frontmatter", () => {
    const content = `---
label: Test
count: 42
---

Body content here.`;

    const result = parseFrontmatter(content);
    expect(result.properties).toEqual({ label: "Test", count: 42 });
    expect(result.body).toBe("\nBody content here.");
  });

  it("handles missing frontmatter", () => {
    const content = "Just a plain markdown file.";
    const result = parseFrontmatter(content);
    expect(result.properties).toEqual({});
    expect(result.body).toBe(content);
  });

  it("handles complex nested properties", () => {
    const content = `---
label: Complex
tags:
  - a
  - b
  - c
metadata:
  source: test
  nested:
    deep: true
---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.properties.tags).toEqual(["a", "b", "c"]);
    expect((result.properties.metadata as any).nested.deep).toBe(true);
  });

  it("does not fall into the Norway problem (NO stays a string)", () => {
    // Under YAML 1.1's default schema, `country: NO` would coerce to false.
    // We use JSON_SCHEMA, which keeps unquoted "NO" as a string.
    const content = `---
country: NO
language: no
---

Body.`;
    const result = parseFrontmatter(content);
    expect(result.properties.country).toBe("NO");
    expect(result.properties.language).toBe("no");
  });

  it("preserves version-like strings as strings", () => {
    const content = `---
version: "1.10"
---

Body.`;
    const result = parseFrontmatter(content);
    expect(result.properties.version).toBe("1.10");
  });

  it("supports multi-line strings via block scalar", () => {
    const content = `---
label: Test
bio: |
  Line one.
  Line two.
---

Body.`;
    const result = parseFrontmatter(content);
    expect(result.properties.bio).toBe("Line one.\nLine two.\n");
  });

  it("throws on invalid YAML", () => {
    const content = `---
label: "unterminated
---

Body.`;

    expect(() => parseFrontmatter(content)).toThrow("Invalid YAML in frontmatter");
  });

  it("throws when frontmatter is a sequence", () => {
    const content = `---
- one
- two
- three
---

Body.`;

    expect(() => parseFrontmatter(content)).toThrow("Frontmatter YAML must be a mapping");
  });

  it("handles empty frontmatter (blank line between fences)", () => {
    const content = `---

---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.properties).toEqual({});
    expect(result.body).toBe("\nBody.");
  });

  it("handles no closing fence", () => {
    const content = `---
label: Test
No closing fence here`;

    const result = parseFrontmatter(content);
    expect(result.properties).toEqual({});
    expect(result.body).toBe(content);
  });

  it("handles leading whitespace before frontmatter", () => {
    const content = `  ---
label: Test
---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.properties.label).toBe("Test");
  });
});

describe("serializeFrontmatter", () => {
  it("serializes properties and body", () => {
    const result = serializeFrontmatter({ label: "Test", count: 42 }, "\nBody content.");
    expect(result.startsWith("---\n")).toBe(true);
    expect(result).toContain("label: Test");
    expect(result).toContain("count: 42");
    expect(result).toContain("Body content.");
  });

  it("round-trips through parse and serialize", () => {
    const original = {
      id: "01ABC",
      label: "Round Trip",
      tags: ["a", "b"],
    };
    const body = "\nSome body content.\n\nWith paragraphs.\n";

    const serialized = serializeFrontmatter(original, body);
    const parsed = parseFrontmatter(serialized);

    expect(parsed.properties).toEqual(original);
    expect(parsed.body).toBe(body);
  });

  it("preserves key insertion order", () => {
    const result = serializeFrontmatter(
      { id: "01ABC", label: "Test", subject_type: "person" },
      "\nbody",
    );
    const idIdx = result.indexOf("id:");
    const labelIdx = result.indexOf("label:");
    const typeIdx = result.indexOf("subject_type:");
    expect(idIdx).toBeLessThan(labelIdx);
    expect(labelIdx).toBeLessThan(typeIdx);
  });

  it("adds leading newline to body if missing", () => {
    const result = serializeFrontmatter({ label: "Test" }, "Body without leading newline.");
    expect(result).toContain("---\n\nBody without leading newline.");
  });
});
