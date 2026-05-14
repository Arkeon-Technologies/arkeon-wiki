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

  it("buckets extensionless files under (none)", () => {
    touch("README");
    touch("LICENSE");
    touch("a.txt");

    const result = scanSources(dir);
    expect(result.supported.by_ext).toEqual({ ".txt": 1 });
    expect(result.unsupported.by_ext).toEqual({ "(none)": 2 });
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
    // INDEX_EXTENSIONS only has lowercase entries; uppercased .TXT
    // becomes ".txt" via the lowercase normalization and lands in
    // supported.
    expect(result.supported.by_ext).toEqual({ ".txt": 1 });
    expect(result.unsupported.by_ext).toEqual({ ".pdf": 2 });
  });
});
