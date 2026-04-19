// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  slugify,
  entityToFilePath,
  loadManifest,
  saveManifest,
  findByEntityId,
  contentHash,
  type Manifest,
} from "../../src/cli/lib/manifest";

describe("slugify", () => {
  test("lowercases and replaces non-alphanumeric with hyphens", () => {
    expect(slugify("Claude Shannon")).toBe("claude-shannon");
  });

  test("strips leading/trailing hyphens", () => {
    expect(slugify("--Hello World--")).toBe("hello-world");
  });

  test("collapses multiple non-alphanumeric into single hyphen", () => {
    expect(slugify("Information Theory (overview)")).toBe("information-theory-overview");
  });

  test("handles unicode and special chars", () => {
    expect(slugify("Résumé & CV")).toBe("r-sum-cv");
  });

  test("truncates to 80 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  test("returns untitled for empty string", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("---")).toBe("untitled");
  });
});

describe("entityToFilePath", () => {
  test("generates wiki/{subject_type}/{slug}.md", () => {
    const entity = {
      id: "01ABC",
      properties: { label: "Entropy", subject_type: "concept" },
    };
    const manifest: Manifest = { version: 1, entries: {} };

    expect(entityToFilePath(entity, manifest)).toBe("wiki/concept/entropy.md");
  });

  test("uses _uncategorized for missing subject_type", () => {
    const entity = {
      id: "01ABC",
      properties: { label: "Something" },
    };
    const manifest: Manifest = { version: 1, entries: {} };

    expect(entityToFilePath(entity, manifest)).toBe("wiki/_uncategorized/something.md");
  });

  test("resolves collisions by appending entity ID suffix", () => {
    const manifest: Manifest = {
      version: 1,
      entries: {
        "wiki/concept/entropy.md": {
          entity_id: "01OTHER_ENTITY",
          ver: 1,
          content_hash: "abc",
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const entity = {
      id: "01NEWENTITY123",
      properties: { label: "Entropy", subject_type: "concept" },
    };

    const path = entityToFilePath(entity, manifest);
    // Last 8 chars of "01NEWENTITY123" = "NTITY123", slugified = "ntity123"
    expect(path).toBe("wiki/concept/entropy-ntity123.md");
    expect(path).not.toBe("wiki/concept/entropy.md");
  });

  test("does not add suffix when same entity owns the path", () => {
    const manifest: Manifest = {
      version: 1,
      entries: {
        "wiki/concept/entropy.md": {
          entity_id: "01SAMEENTITY",
          ver: 1,
          content_hash: "abc",
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const entity = {
      id: "01SAMEENTITY",
      properties: { label: "Entropy", subject_type: "concept" },
    };

    expect(entityToFilePath(entity, manifest)).toBe("wiki/concept/entropy.md");
  });
});

describe("manifest I/O", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `arkeon-manifest-test-${Date.now()}`);
    mkdirSync(join(tmpDir, ".arkeon"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadManifest returns empty manifest when file missing", () => {
    const m = loadManifest(tmpDir);
    expect(m.version).toBe(1);
    expect(Object.keys(m.entries)).toHaveLength(0);
  });

  test("saveManifest then loadManifest round-trips", () => {
    const manifest: Manifest = {
      version: 1,
      entries: {
        "wiki/concept/entropy.md": {
          entity_id: "01ABC",
          ver: 3,
          content_hash: "deadbeef",
          synced_at: "2026-04-18T12:00:00Z",
        },
      },
    };

    saveManifest(manifest, tmpDir);

    // File should exist
    expect(existsSync(join(tmpDir, ".arkeon", "manifest.json"))).toBe(true);

    const loaded = loadManifest(tmpDir);
    expect(loaded).toEqual(manifest);
  });

  test("loadManifest strips entries with unsafe paths", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: {
        "wiki/concept/safe.md": {
          entity_id: "01SAFE",
          ver: 1,
          content_hash: "abc",
          synced_at: "2026-01-01T00:00:00Z",
        },
        "../../../etc/passwd": {
          entity_id: "01EVIL",
          ver: 1,
          content_hash: "abc",
          synced_at: "2026-01-01T00:00:00Z",
        },
        "/absolute/path.md": {
          entity_id: "01ABS",
          ver: 1,
          content_hash: "abc",
          synced_at: "2026-01-01T00:00:00Z",
        },
        "not-wiki/file.md": {
          entity_id: "01OUT",
          ver: 1,
          content_hash: "abc",
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    });
    writeFileSync(join(tmpDir, ".arkeon", "manifest.json"), raw);

    const m = loadManifest(tmpDir);
    expect(Object.keys(m.entries)).toHaveLength(1);
    expect(m.entries["wiki/concept/safe.md"]).toBeTruthy();
  });

  test("loadManifest rejects invalid version", () => {
    writeFileSync(
      join(tmpDir, ".arkeon", "manifest.json"),
      JSON.stringify({ version: 99, entries: {} }),
    );
    expect(() => loadManifest(tmpDir)).toThrow("unsupported version");
  });

  test("loadManifest skips entries with invalid shape", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: {
        "wiki/concept/good.md": {
          entity_id: "01GOOD",
          ver: 1,
          content_hash: "abc",
          synced_at: "2026-01-01T00:00:00Z",
        },
        "wiki/concept/bad.md": {
          entity_id: 123, // wrong type
          ver: "not a number",
        },
        "wiki/concept/null.md": null,
      },
    });
    writeFileSync(join(tmpDir, ".arkeon", "manifest.json"), raw);

    const m = loadManifest(tmpDir);
    expect(Object.keys(m.entries)).toHaveLength(1);
    expect(m.entries["wiki/concept/good.md"]).toBeTruthy();
  });

  test("findByEntityId returns matching entry", () => {
    const manifest: Manifest = {
      version: 1,
      entries: {
        "wiki/concept/a.md": {
          entity_id: "01AAA",
          ver: 1,
          content_hash: "aaa",
          synced_at: "2026-01-01T00:00:00Z",
        },
        "wiki/person/b.md": {
          entity_id: "01BBB",
          ver: 2,
          content_hash: "bbb",
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const found = findByEntityId(manifest, "01BBB");
    expect(found).not.toBeNull();
    expect(found!.path).toBe("wiki/person/b.md");
    expect(found!.entry.ver).toBe(2);
  });

  test("findByEntityId returns null when not found", () => {
    const manifest: Manifest = { version: 1, entries: {} };
    expect(findByEntityId(manifest, "01MISSING")).toBeNull();
  });
});

describe("contentHash", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `arkeon-hash-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("produces consistent SHA-256 for same content", () => {
    const file = join(tmpDir, "test.md");
    writeFileSync(file, "hello world\n");

    const h1 = contentHash(file);
    const h2 = contentHash(file);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });

  test("produces different hashes for different content", () => {
    const f1 = join(tmpDir, "a.md");
    const f2 = join(tmpDir, "b.md");
    writeFileSync(f1, "content A");
    writeFileSync(f2, "content B");

    expect(contentHash(f1)).not.toBe(contentHash(f2));
  });
});
