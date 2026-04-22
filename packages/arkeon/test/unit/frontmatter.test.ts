// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "../../src/server/lib/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses valid JSON frontmatter", () => {
    const content = `---
{
  "label": "Test",
  "count": 42
}
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
{
  "label": "Complex",
  "tags": ["a", "b", "c"],
  "metadata": {
    "source": "test",
    "nested": { "deep": true }
  }
}
---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.properties.tags).toEqual(["a", "b", "c"]);
    expect((result.properties.metadata as any).nested.deep).toBe(true);
  });

  it("throws on invalid JSON", () => {
    const content = `---
{ not valid json
---

Body.`;

    expect(() => parseFrontmatter(content)).toThrow("Invalid JSON in frontmatter");
  });

  it("throws when frontmatter is an array", () => {
    const content = `---
[1, 2, 3]
---

Body.`;

    expect(() => parseFrontmatter(content)).toThrow("Frontmatter JSON must be an object");
  });

  it("handles empty properties object", () => {
    const content = `---
{}
---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.properties).toEqual({});
    expect(result.body).toBe("\nBody.");
  });

  it("handles no closing fence", () => {
    const content = `---
{ "label": "Test" }
No closing fence here`;

    const result = parseFrontmatter(content);
    expect(result.properties).toEqual({});
    expect(result.body).toBe(content);
  });

  it("handles leading whitespace before frontmatter", () => {
    const content = `  ---
{
  "label": "Test"
}
---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.properties.label).toBe("Test");
  });

  it("preserves special characters in values", () => {
    const content = `---
{
  "label": "Test with \\"quotes\\" and\\nnewlines",
  "emoji": "Hello"
}
---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.properties.label).toBe('Test with "quotes" and\nnewlines');
  });
});

describe("serializeFrontmatter", () => {
  it("serializes properties and body", () => {
    const result = serializeFrontmatter({ label: "Test", count: 42 }, "\nBody content.");
    expect(result).toContain("---\n");
    expect(result).toContain('"label": "Test"');
    expect(result).toContain('"count": 42');
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

  it("adds leading newline to body if missing", () => {
    const result = serializeFrontmatter({ label: "Test" }, "Body without leading newline.");
    expect(result).toContain("---\n\nBody without leading newline.");
  });
});
