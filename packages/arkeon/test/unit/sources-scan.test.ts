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

  it("partitions supported and unsupported by extension", () => {
    touch("a.txt");
    touch("b.txt");
    touch("c.json");
    touch("notes/d.html");
    touch("binary.pdf");
    touch("photo.png");
    touch("photo2.png");

    const result = scanSources(dir);
    expect(result.total).toBe(7);
    expect(result.supported.count).toBe(4);
    expect(result.supported.by_ext).toEqual({ ".txt": 2, ".json": 1, ".html": 1 });
    expect(result.unsupported.count).toBe(3);
    expect(result.unsupported.by_ext).toEqual({ ".png": 2, ".pdf": 1 });
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

  it("rejects extensionless binaries via content sniff (NUL bytes present)", () => {
    // A file with a single NUL byte is unambiguously binary —
    // the sniff catches it even without an extension hint.
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]); // ELF header start
    touch("opaque-bin", binary.toString("binary"));
    touch("readme.txt", "text");

    const result = scanSources(dir);
    expect(result.supported.by_ext).toEqual({ ".txt": 1 });
    expect(result.unsupported.by_ext).toEqual({ "(none)": 1 });
  });

  it("rejects unknown-extension files containing NUL bytes via content sniff", () => {
    // An unknown extension (.xyz) is neither denylisted nor allowlisted;
    // the sniff is what gates it. NUL byte → binary → unsupported.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    touch("opaque.xyz", binary.toString("binary"));
    touch("text.xyz", "no nulls here, just text");

    const result = scanSources(dir);
    expect(result.supported.by_ext).toEqual({ ".xyz": 1 });
    expect(result.unsupported.by_ext).toEqual({ ".xyz": 1 });
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
    for (let i = 0; i < 7; i++) touch(`doc-${i}.pdf`);
    const result = scanSources(dir);
    expect(result.unsupported.by_ext[".pdf"]).toBe(7);
    expect(result.unsupported.examples[".pdf"]).toHaveLength(5);
  });

  it("sorts by_ext by count descending", () => {
    touch("a.png");
    touch("b.pdf");
    touch("c.pdf");
    touch("d.pdf");
    touch("e.docx");
    touch("f.docx");

    const result = scanSources(dir);
    expect(Object.keys(result.unsupported.by_ext)).toEqual([".pdf", ".docx", ".png"]);
  });

  it("normalizes extensions to lowercase", () => {
    touch("a.PDF");
    touch("b.pdf");
    touch("c.TXT");
    const result = scanSources(dir);
    // Extension sets only have lowercase entries; uppercased .TXT
    // becomes ".txt" via the lowercase normalization and lands in
    // supported.
    expect(result.supported.by_ext).toEqual({ ".txt": 1 });
    expect(result.unsupported.by_ext).toEqual({ ".pdf": 2 });
  });
});
