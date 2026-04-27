// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeLabel,
  slugify,
  placeholderPath,
  findFreePath,
} from "../../src/server/lib/contributions.js";
import { withPathLock } from "../../src/server/lib/path-lock.js";

describe("normalizeLabel", () => {
  it("lowercases and trims", () => {
    expect(normalizeLabel("  Claude Shannon  ")).toBe("claude shannon");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeLabel("Claude   Shannon")).toBe("claude shannon");
    expect(normalizeLabel("Claude\tShannon")).toBe("claude shannon");
  });

  it("treats different casing as equivalent", () => {
    expect(normalizeLabel("CLAUDE SHANNON")).toBe(normalizeLabel("claude shannon"));
  });

  it("preserves non-ASCII characters", () => {
    expect(normalizeLabel("Émile Durkheim")).toBe("émile durkheim");
  });
});

describe("slugify", () => {
  it("converts spaces to hyphens", () => {
    expect(slugify("Claude Shannon")).toBe("claude-shannon");
  });

  it("strips punctuation", () => {
    expect(slugify("AT&T Bell Labs")).toBe("att-bell-labs");
  });

  it("collapses repeated hyphens", () => {
    expect(slugify("Foo -- Bar")).toBe("foo-bar");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("-foo-")).toBe("foo");
  });

  it("falls back to 'untitled' for empty input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("---")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
  });

  it("preserves digits", () => {
    expect(slugify("Y2K Bug")).toBe("y2k-bug");
  });
});

describe("placeholderPath", () => {
  it("uses subject_type as the directory", () => {
    expect(placeholderPath("person", "Claude Shannon")).toBe(
      "wiki/person/claude-shannon.md",
    );
  });

  it("falls back to 'wiki' when subject_type is missing", () => {
    expect(placeholderPath(undefined, "Some Concept")).toBe("wiki/wiki/some-concept.md");
  });

  it("slugifies subject_type too", () => {
    expect(placeholderPath("Research Paper", "Foo")).toBe("wiki/research-paper/foo.md");
  });
});

describe("findFreePath", () => {
  it("returns the base path when nothing exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "arkeon-free-"));
    try {
      expect(findFreePath(dir, "wiki/person/foo.md")).toBe("wiki/person/foo.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends a numeric suffix when the path is taken", () => {
    const dir = mkdtempSync(join(tmpdir(), "arkeon-free-"));
    try {
      mkdirSync(join(dir, "wiki/person"), { recursive: true });
      writeFileSync(join(dir, "wiki/person/foo.md"), "");
      expect(findFreePath(dir, "wiki/person/foo.md")).toBe("wiki/person/foo-2.md");

      writeFileSync(join(dir, "wiki/person/foo-2.md"), "");
      expect(findFreePath(dir, "wiki/person/foo.md")).toBe("wiki/person/foo-3.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withPathLock", () => {
  it("serializes work scheduled for the same path", async () => {
    const order: string[] = [];

    const slow = withPathLock("a", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
    });
    const fast = withPathLock("a", async () => {
      order.push("fast");
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("runs different paths in parallel", async () => {
    const events: string[] = [];

    const a = withPathLock("a", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("a-end");
    });
    const b = withPathLock("b", async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("b-end");
    });

    await Promise.all([a, b]);

    // Both should start before either ends — proves they ran concurrently.
    const aStart = events.indexOf("a-start");
    const aEnd = events.indexOf("a-end");
    const bStart = events.indexOf("b-start");
    expect(bStart).toBeLessThan(aEnd);
    expect(aStart).toBeLessThan(events.indexOf("b-end"));
  });

  it("does not block subsequent work after a rejection", async () => {
    let ran = false;
    await expect(
      withPathLock("c", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await withPathLock("c", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
