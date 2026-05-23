// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanSources } from "../../src/server/lib/sources-scan.js";

describe("scanSources", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arkeon-scan-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(rel: string, content = ""): void {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  it("returns empty buckets on an empty directory", () => {
    const result = scanSources(dir);
    expect(result.total).toBe(0);
    expect(result.supported.count).toBe(0);
    expect(result.unsupported.count).toBe(0);
    expect(result.supported.by_ext).toEqual({});
    expect(result.unsupported.by_ext).toEqual({});
  });

  it("partitions supported and unsupported by extension (assets are now supported)", () => {
    // Under the asset-indexing model, PDFs / PNGs are eligible — they
    // get entity rows with kind='asset'. Only secrets and junk land in
    // unsupported. Use a .env file to exercise the unsupported bucket.
    touch("a.txt");
    touch("b.txt");
    touch("c.json");
    touch("notes/d.html");
    touch("binary.pdf");
    touch("photo.png");
    touch("photo2.png");
    touch("production.env", "SECRET=hidden");

    const result = scanSources(dir);
    expect(result.total).toBe(8);
    expect(result.supported.count).toBe(7);
    expect(result.supported.by_ext).toEqual({
      ".txt": 2,
      ".png": 2,
      ".json": 1,
      ".html": 1,
      ".pdf": 1,
    });
    expect(result.unsupported.count).toBe(1);
    expect(result.unsupported.by_ext).toEqual({ ".env": 1 });
  });

  it("indexes extensionless text files (README, LICENSE) via content sniff", () => {
    // README / LICENSE are the canonical extensionless-text case. The
    // sniff sees zero NUL bytes → eligible. They land in supported
    // under the "(none)" bucket so the operator can still see them
    // distinctly from .txt etc.
    touch("README", "# Project\n\nDocs here.\n");
    touch("LICENSE", "MIT License\n\n...\n");
    touch("a.txt", "hello");

    const result = scanSources(dir);
    expect(result.supported.by_ext).toEqual({ "(none)": 2, ".txt": 1 });
    expect(result.unsupported.by_ext).toEqual({});
  });

  it("includes extensionless binaries as supported (eligibility is path-only now)", () => {
    // Under the asset-indexing model, scanSources reports "supported"
    // for anything that will get an entity row — text or asset. The
    // text-vs-asset distinction is the watcher's classification step,
    // not the scan's responsibility. An extensionless binary just gets
    // kind='asset' on classification.
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]); // ELF header
    touch("opaque-bin", binary.toString("binary"));
    touch("readme.txt", "text");

    const result = scanSources(dir);
    expect(result.supported.by_ext).toEqual({ ".txt": 1, "(none)": 1 });
    expect(result.unsupported.by_ext).toEqual({});
  });

  it("includes unknown-extension files (text and binary) as supported", () => {
    // Unknown extensions aren't denylisted, so they're eligible. The
    // sniff happens later inside classifyFile to decide text vs asset
    // — irrelevant to the scan's supported/unsupported partition.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    touch("opaque.xyz", binary.toString("binary"));
    touch("text.xyz", "no nulls here, just text");

    const result = scanSources(dir);
    expect(result.supported.by_ext).toEqual({ ".xyz": 2 });
    expect(result.unsupported.by_ext).toEqual({});
  });

  it("skips ignored directories (.git, node_modules, .arkeon, hidden)", () => {
    touch(".git/config");
    touch("node_modules/foo/package.json");
    touch(".arkeon/state.json");
    touch(".hidden/secret.txt");
    touch("real.txt");

    const result = scanSources(dir);
    expect(result.total).toBe(1);
    expect(result.supported.by_ext).toEqual({ ".txt": 1 });
  });

  it("limits unsupported examples to 5 per extension", () => {
    // .env is SKIP_EXTENSIONS — unsupported. Need 7+ to exercise the cap.
    for (let i = 0; i < 7; i++) touch(`stage-${i}.env`);
    const result = scanSources(dir);
    expect(result.unsupported.by_ext[".env"]).toBe(7);
    expect(result.unsupported.examples[".env"]).toHaveLength(5);
  });

  it("sorts supported by_ext by count descending", () => {
    touch("a.png");
    touch("b.pdf");
    touch("c.pdf");
    touch("d.pdf");
    touch("e.docx");
    touch("f.docx");

    const result = scanSources(dir);
    expect(Object.keys(result.supported.by_ext)).toEqual([".pdf", ".docx", ".png"]);
  });

  it("normalizes extensions to lowercase", () => {
    // .PDF and .pdf both normalize to .pdf — both supported as assets.
    // .TXT normalizes to .txt — supported as text.
    touch("a.PDF");
    touch("b.pdf");
    touch("c.TXT");
    const result = scanSources(dir);
    expect(result.supported.by_ext).toEqual({ ".pdf": 2, ".txt": 1 });
    expect(result.unsupported.by_ext).toEqual({});
  });
});
