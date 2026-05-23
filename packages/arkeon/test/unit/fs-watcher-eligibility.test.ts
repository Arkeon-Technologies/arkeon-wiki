// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused tests for fs-watcher's eligibility + classification. Under
 * the asset-indexing model, eligibility is "is this a non-junk file"
 * and classification (text vs asset) is a separate decision. Both
 * surfaces are tested here directly so the contract stays explicit
 * (and fast to iterate on when the rules change).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyFile,
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

    it("rejects SKIP_EXTENSIONS (secrets + editor scratch)", () => {
      // Suffix-form .env (without leading dot) is the case shouldIgnorePath
      // misses — only SKIP_EXTENSIONS catches it.
      expect(isPathPotentiallyEligible("production.env")).toBe(false);
      expect(isPathPotentiallyEligible("staging.env")).toBe(false);
      expect(isPathPotentiallyEligible("server.pem")).toBe(false);
      expect(isPathPotentiallyEligible("notes.swp")).toBe(false);
      expect(isPathPotentiallyEligible("draft.tmp")).toBe(false);
    });

    it("rejects junk basenames (.DS_Store, Thumbs.db)", () => {
      expect(isPathPotentiallyEligible(".DS_Store")).toBe(false);
      expect(isPathPotentiallyEligible("Thumbs.db")).toBe(false);
      expect(isPathPotentiallyEligible("nested/sub/.DS_Store")).toBe(false);
    });

    it("accepts text-extension files", () => {
      expect(isPathPotentiallyEligible("notes.md")).toBe(true);
      expect(isPathPotentiallyEligible("README")).toBe(true);
      expect(isPathPotentiallyEligible("config.xyz")).toBe(true);
    });

    it("accepts asset-extension files (now indexable as kind='asset')", () => {
      // Pre-asset-indexing, the BINARY_EXTENSIONS denylist refused
      // these; now they're eligible (classification picks kind='asset').
      expect(isPathPotentiallyEligible("doc.pdf")).toBe(true);
      expect(isPathPotentiallyEligible("img.png")).toBe(true);
      expect(isPathPotentiallyEligible("archive.zip")).toBe(true);
      expect(isPathPotentiallyEligible("song.mp3")).toBe(true);
      expect(isPathPotentiallyEligible("video.mp4")).toBe(true);
    });
  });

  describe("isEligibleFile", () => {
    // isEligibleFile is now just a path-based check (the content sniff
    // moved to classifyFile). It accepts assets too.

    it("indexes text-extension files", () => {
      touch("notes.md", "# Hello");
      expect(isEligibleFile("notes.md", join(dir, "notes.md"))).toBe(true);
    });

    it("indexes asset-extension files (kind classification happens separately)", () => {
      touch("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(isEligibleFile("img.png", join(dir, "img.png"))).toBe(true);
    });

    it("refuses to index *.env files even though content is text", () => {
      touch("production.env", "DATABASE_URL=postgres://user:secret@host/db\n");
      expect(isEligibleFile("production.env", join(dir, "production.env"))).toBe(false);
    });

    it("refuses to index credential / key files", () => {
      touch("server.pem", "-----BEGIN PRIVATE KEY-----\n...\n");
      expect(isEligibleFile("server.pem", join(dir, "server.pem"))).toBe(false);
    });

    it("refuses to index junk basenames regardless of subdir", () => {
      touch(".DS_Store", "");
      touch("nested/.DS_Store", "");
      expect(isEligibleFile(".DS_Store", join(dir, ".DS_Store"))).toBe(false);
      expect(isEligibleFile("nested/.DS_Store", join(dir, "nested/.DS_Store"))).toBe(false);
    });
  });

  describe("classifyFile", () => {
    it("returns 'text' for TEXT_EXTENSIONS without inspecting content", () => {
      touch("notes.md", "# Hello");
      expect(classifyFile("notes.md", join(dir, "notes.md"))).toBe("text");
    });

    it("returns 'asset' for ASSET_EXTENSIONS without inspecting content", () => {
      touch("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      touch("doc.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46]));
      touch("archive.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(classifyFile("img.png", join(dir, "img.png"))).toBe("asset");
      expect(classifyFile("doc.pdf", join(dir, "doc.pdf"))).toBe("asset");
      expect(classifyFile("archive.zip", join(dir, "archive.zip"))).toBe("asset");
    });

    it("sniffs extensionless files: text → 'text'", () => {
      touch("README", "# Project\n");
      expect(classifyFile("README", join(dir, "README"))).toBe("text");
    });

    it("sniffs extensionless files: binary → 'asset'", () => {
      touch("blob", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
      expect(classifyFile("blob", join(dir, "blob"))).toBe("asset");
    });

    it("sniffs unknown extensions both ways", () => {
      touch("config.xyz", "key=value\n");
      touch("opaque.xyz", Buffer.from([0x01, 0x00, 0x02]));
      expect(classifyFile("config.xyz", join(dir, "config.xyz"))).toBe("text");
      expect(classifyFile("opaque.xyz", join(dir, "opaque.xyz"))).toBe("asset");
    });

    it("falls back to 'asset' on unreadable files (safe default — asset-mode reads no content)", () => {
      expect(classifyFile("missing", join(dir, "missing"))).toBe("asset");
    });
  });

  describe("walkEligibleFiles", () => {
    it("returns extensionless text files (README, LICENSE)", () => {
      touch("README", "# Hello\n");
      touch("LICENSE", "MIT\n");
      const files = walkEligibleFiles(dir);
      expect(files.sort()).toEqual(["LICENSE", "README"]);
    });

    it("walks return extensionless binary files (eligibility is path-only now)", () => {
      // Under the old three-tier check, an extensionless binary was
      // rejected by the sniff. Under the asset-indexing model, eligibility
      // is path-only — the sniff happens inside classifyFile, NOT here.
      // The walk surfaces every non-junk file; classification decides
      // text vs asset later.
      touch("README", "# Hello\n");
      touch("opaque", Buffer.from([0x00, 0x01, 0x02]));
      const files = walkEligibleFiles(dir).sort();
      expect(files).toEqual(["README", "opaque"]);
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

    it("includes asset-extension files (now eligible as kind='asset')", () => {
      touch("fake.pdf", "this looks like text but the ext says binary");
      touch("real.md", "# real");
      const files = walkEligibleFiles(dir).sort();
      expect(files).toEqual(["fake.pdf", "real.md"]);
    });

    it("skips junk basenames", () => {
      touch(".DS_Store", "");
      touch("Thumbs.db", "");
      touch("nested/.DS_Store", "");
      touch("real.md", "# real");
      const files = walkEligibleFiles(dir);
      expect(files).toEqual(["real.md"]);
    });
  });
});
