// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { serializeEntity, parseEntityFile } from "../../src/cli/lib/wiki-serialization";

describe("serializeEntity", () => {
  test("serializes a full entity with all fields", () => {
    const entity = {
      id: "01JSGXXXXXXXXX",
      ver: 3,
      properties: {
        label: "Entropy",
        subject_type: "concept",
        aliases: ["thermodynamic entropy", "S"],
        keywords: ["entropy", "thermodynamics"],
        short_description: "A measure of disorder in a thermodynamic system.",
        content: "Entropy is a fundamental concept. See [[entity:01JSGYYY]].",
        submitted_content: 'Entropy is a fundamental concept. See [[resolve:"Information Theory"|"mathematical theory"]].',
        status: "published",
      },
    };

    const md = serializeEntity(entity);

    // Frontmatter should contain id, ver, metadata
    expect(md).toContain("id: 01JSGXXXXXXXXX");
    expect(md).toContain("ver: 3");
    expect(md).toContain("subject_type: concept");
    expect(md).toContain("- thermodynamic entropy");
    expect(md).toContain("- S");
    expect(md).toContain("- entropy");
    expect(md).toContain("short_description:");

    // Should use submitted_content (not resolved content)
    expect(md).toContain('[[resolve:"Information Theory"');
    expect(md).not.toContain("[[entity:01JSGYYY]]");

    // Label should become H1
    expect(md).toContain("# Entropy");

    // Should NOT include status or label in frontmatter
    expect(md).not.toMatch(/^status:/m);
    // label is used as H1, not in frontmatter
  });

  test("uses content when submitted_content is missing", () => {
    const entity = {
      id: "01ABC",
      ver: 1,
      properties: {
        label: "Test",
        content: "Some resolved content with [[entity:01XYZ]].",
      },
    };

    const md = serializeEntity(entity);
    expect(md).toContain("[[entity:01XYZ]]");
  });

  test("does not duplicate H1 if content already has one", () => {
    const entity = {
      id: "01ABC",
      ver: 1,
      properties: {
        label: "My Page",
        content: "# My Page\n\nBody text here.",
      },
    };

    const md = serializeEntity(entity);
    // Should have exactly one H1
    const h1Count = (md.match(/^# /gm) || []).length;
    expect(h1Count).toBe(1);
  });

  test("handles entity with minimal properties", () => {
    const entity = {
      id: "01MIN",
      ver: 1,
      properties: {
        label: "Minimal",
        content: "Just some text.",
      },
    };

    const md = serializeEntity(entity);
    expect(md).toContain("---");
    expect(md).toContain("id: 01MIN");
    expect(md).toContain("# Minimal");
    expect(md).toContain("Just some text.");
    // No subject_type, aliases, keywords should be absent
    expect(md).not.toContain("subject_type:");
    expect(md).not.toContain("aliases:");
    expect(md).not.toContain("keywords:");
  });

  test("includes custom properties under properties: key", () => {
    const entity = {
      id: "01CUS",
      ver: 1,
      properties: {
        label: "Custom",
        content: "Body.",
        my_custom_field: "custom_value",
        another_field: 42,
      },
    };

    const md = serializeEntity(entity);
    expect(md).toContain("properties:");
    expect(md).toContain("my_custom_field: custom_value");
    expect(md).toContain("another_field: 42");
  });
});

describe("parseEntityFile", () => {
  test("parses frontmatter + H1 + body", () => {
    const md = [
      "---",
      "id: 01JSGXXXXXXXXX",
      "ver: 3",
      "subject_type: concept",
      "aliases:",
      "  - thermodynamic entropy",
      "  - S",
      "keywords:",
      "  - entropy",
      "  - thermodynamics",
      "short_description: A measure of disorder.",
      "---",
      "",
      "# Entropy",
      "",
      "Entropy is fundamental.",
    ].join("\n");

    const parsed = parseEntityFile(md);

    expect(parsed.id).toBe("01JSGXXXXXXXXX");
    expect(parsed.ver).toBe(3);
    expect(parsed.label).toBe("Entropy");
    expect(parsed.subject_type).toBe("concept");
    expect(parsed.aliases).toEqual(["thermodynamic entropy", "S"]);
    expect(parsed.keywords).toEqual(["entropy", "thermodynamics"]);
    expect(parsed.short_description).toBe("A measure of disorder.");
    expect(parsed.content).toContain("Entropy is fundamental.");
    // H1 should be stripped from content
    expect(parsed.content).not.toContain("# Entropy");
  });

  test("parses file without frontmatter", () => {
    const md = "# My Title\n\nSome body text.";

    const parsed = parseEntityFile(md);

    expect(parsed.id).toBeUndefined();
    expect(parsed.ver).toBeUndefined();
    expect(parsed.label).toBe("My Title");
    expect(parsed.content).toBe("Some body text.");
  });

  test("falls back to Untitled when no H1", () => {
    const md = [
      "---",
      "id: 01ABC",
      "ver: 1",
      "---",
      "",
      "Just body text, no heading.",
    ].join("\n");

    const parsed = parseEntityFile(md);
    expect(parsed.label).toBe("Untitled");
    expect(parsed.content).toContain("Just body text");
  });

  test("handles custom properties in frontmatter", () => {
    const md = [
      "---",
      "id: 01ABC",
      "ver: 1",
      "properties:",
      "  my_field: hello",
      "  count: 42",
      "---",
      "",
      "# Test",
      "",
      "Body.",
    ].join("\n");

    const parsed = parseEntityFile(md);
    expect(parsed.properties).toEqual({ my_field: "hello", count: 42 });
  });
});

describe("round-trip serialization", () => {
  test("serialize then parse preserves all fields", () => {
    const original = {
      id: "01ROUND",
      ver: 5,
      properties: {
        label: "Round Trip Test",
        subject_type: "concept",
        aliases: ["roundtrip", "RT"],
        keywords: ["testing", "serialization"],
        short_description: "Tests the round-trip.",
        content: "This is the body.\n\nWith multiple paragraphs.",
        submitted_content: 'This is the body with [[resolve:"Something"|"desc"]].\n\nWith multiple paragraphs.',
        status: "published",
      },
    };

    const serialized = serializeEntity(original);
    const parsed = parseEntityFile(serialized);

    expect(parsed.id).toBe("01ROUND");
    expect(parsed.ver).toBe(5);
    expect(parsed.label).toBe("Round Trip Test");
    expect(parsed.subject_type).toBe("concept");
    expect(parsed.aliases).toEqual(["roundtrip", "RT"]);
    expect(parsed.keywords).toEqual(["testing", "serialization"]);
    expect(parsed.short_description).toBe("Tests the round-trip.");
    // Content should use submitted_content
    expect(parsed.content).toContain('[[resolve:"Something"');
  });

  test("serialize then parse with minimal entity", () => {
    const original = {
      id: "01MINI",
      ver: 1,
      properties: {
        label: "Simple",
        content: "Just text.",
      },
    };

    const serialized = serializeEntity(original);
    const parsed = parseEntityFile(serialized);

    expect(parsed.id).toBe("01MINI");
    expect(parsed.ver).toBe(1);
    expect(parsed.label).toBe("Simple");
    expect(parsed.content).toBe("Just text.");
  });

  test("YAML escapes special characters correctly", () => {
    const original = {
      id: "01SPEC",
      ver: 1,
      properties: {
        label: "Special: Characters & More",
        content: "Body text.",
        short_description: "Contains \"quotes\" and colons: yes",
      },
    };

    const serialized = serializeEntity(original);
    const parsed = parseEntityFile(serialized);

    expect(parsed.short_description).toBe('Contains "quotes" and colons: yes');
  });
});
