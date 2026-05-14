// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused tests for the three-tier eligibility check in fs-watcher.
 * scanSources and the e2e watcher cover this transitively, but a direct
 * test for walkEligibleFiles + sniffIsText keeps the contract explicit
 * (and fast to run when iterating on the rules).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isEligibleFile,
  isPathPotentiallyEligible,
  sniffIsText,
  walkEligibleFiles,
} from "../../src/server/lib/fs-watcher.js";

describe("eligibility", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arkeon-eligibility-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(rel: string, content: string | Buffer = ""): void {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  describe("sniffIsText", () => {
    it("treats files with no NUL bytes as text", () => {
      touch("a.bin", "hello world");
      expect(sniffIsText(join(dir, "a.bin"))).toBe(true);
    });

    it("treats files with a NUL byte as binary", () => {
      touch("b.bin", Buffer.from([0x68, 0x69, 0x00, 0x21]));
      expect(sniffIsText(join(dir, "b.bin"))).toBe(false);
    });

    it("treats empty files as text", () => {
      touch("empty");
      expect(sniffIsText(join(dir, "empty"))).toBe(true);
    });

    it("returns false on unreadable / missing paths", () => {
      expect(sniffIsText(join(dir, "does-not-exist"))).toBe(false);
    });
  });

  describe("isPathPotentiallyEligible", () => {
    it("rejects hidden / ignored paths", () => {
      expect(isPathPotentiallyEligible(".env")).toBe(false);
      expect(isPathPotentiallyEligible(".git/config")).toBe(false);
      expect(isPathPotentiallyEligible("node_modules/foo.js")).toBe(false);
      expect(isPathPotentiallyEligible(".arkeon/state.json")).toBe(false);
    });

    it("rejects known-binary extensions", () => {
      expect(isPathPotentiallyEligible("doc.pdf")).toBe(false);
      expect(isPathPotentiallyEligible("img.png")).toBe(false);
      expect(isPathPotentiallyEligible("archive.zip")).toBe(false);
    });

    it("passes through text extensions and unknowns (sniff happens later)", () => {
      expect(isPathPotentiallyEligible("notes.md")).toBe(true);
      expect(isPathPotentiallyEligible("README")).toBe(true);
      expect(isPathPotentiallyEligible("config.xyz")).toBe(true);
    });
  });

  describe("isEligibleFile", () => {
    it("indexes known-text extensions without inspecting content", () => {
      touch("notes.md", "# Hello");
      expect(isEligibleFile("notes.md", join(dir, "notes.md"))).toBe(true);
    });

    it("rejects known-binary extensions without inspecting content", () => {
      // Even text-looking content can't override a binary extension —
      // it's the user's signal of intent.
      touch("fake.pdf", "totally not a pdf, but the extension says it is");
      expect(isEligibleFile("fake.pdf", join(dir, "fake.pdf"))).toBe(false);
    });

    it("sniffs extensionless files: text → eligible", () => {
      touch("README", "# Project\n\nDocs go here.\n");
      expect(isEligibleFile("README", join(dir, "README"))).toBe(true);
    });

    it("sniffs extensionless files: binary → not eligible", () => {
      touch("blob", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
      expect(isEligibleFile("blob", join(dir, "blob"))).toBe(false);
    });

    it("sniffs unknown extensions both ways", () => {
      touch("config.xyz", "key=value\n");
      touch("opaque.xyz", Buffer.from([0x01, 0x00, 0x02]));
      expect(isEligibleFile("config.xyz", join(dir, "config.xyz"))).toBe(true);
      expect(isEligibleFile("opaque.xyz", join(dir, "opaque.xyz"))).toBe(false);
    });

    it("refuses to index *.env files even though their content is text", () => {
      // Files like `production.env` / `staging.env` have no dot prefix,
      // so shouldIgnorePath misses them. Their content is text, so the
      // sniff alone would let them through. BINARY_EXTENSIONS gates
      // them out explicitly — that's the only durable defense.
      touch("production.env", "DATABASE_URL=postgres://user:secret@host/db\n");
      touch("staging.env", "API_KEY=sk-redacted-but-still-text\n");
      expect(isEligibleFile("production.env", join(dir, "production.env"))).toBe(false);
      expect(isEligibleFile("staging.env", join(dir, "staging.env"))).toBe(false);
    });

    it("refuses to index credential / key files even though their content is text", () => {
      touch(
        "server.pem",
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n",
      );
      touch("backup.kdbx", "fake keepass bytes but legible as text");
      expect(isEligibleFile("server.pem", join(dir, "server.pem"))).toBe(false);
      expect(isEligibleFile("backup.kdbx", join(dir, "backup.kdbx"))).toBe(false);
    });
  });

  describe("walkEligibleFiles", () => {
    it("returns extensionless text files (README, LICENSE)", () => {
      touch("README", "# Hello\n");
      touch("LICENSE", "MIT\n");
      const files = walkEligibleFiles(dir);
      expect(files.sort()).toEqual(["LICENSE", "README"]);
    });

    it("skips extensionless binary files via sniff", () => {
      touch("README", "# Hello\n");
      touch("opaque", Buffer.from([0x00, 0x01, 0x02]));
      const files = walkEligibleFiles(dir);
      expect(files).toEqual(["README"]);
    });

    it("skips ignored directories", () => {
      touch(".git/config", "[core]\n");
      touch("node_modules/foo/index.js", "module.exports = 1;");
      touch(".arkeon/state.json", "{}");
      touch("src/real.ts", "export const x = 1;");
      const files = walkEligibleFiles(dir);
      expect(files).toEqual(["src/real.ts"]);
    });

    it("recurses into subdirectories", () => {
      touch("a/b/c/deep.md", "# deep");
      touch("top.md", "# top");
      const files = walkEligibleFiles(dir).sort();
      expect(files).toEqual(["a/b/c/deep.md", "top.md"]);
    });

    it("excludes known-binary extensions even when their bytes are text-shaped", () => {
      touch("fake.pdf", "this looks like text but the ext says binary");
      touch("real.md", "# real");
      const files = walkEligibleFiles(dir);
      expect(files).toEqual(["real.md"]);
    });
  });
});
