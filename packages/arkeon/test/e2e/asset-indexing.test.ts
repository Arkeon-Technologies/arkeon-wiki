// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2e tests for the asset-indexing model:
 *
 *   - Binary files (images, PDFs, archives) get entity rows with
 *     kind='asset' instead of being skipped.
 *   - Asset rows carry {file_type, size_bytes} in properties, no
 *     parsed metadata, no link extraction.
 *   - Links from wikis to assets resolve (no red link) once the asset
 *     is indexed.
 *   - listEntities `kinds` filter scopes queue queries: kind='text'
 *     excludes assets, kind='asset' returns only attachments.
 *   - listRedLinks naturally drops assets once they have entity rows.
 *   - The stat-fingerprint cache short-circuits unchanged files
 *     (action='unchanged' without recomputing the content hash).
 *   - A touch-without-content-change refreshes the fingerprint but
 *     keeps source_hash unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../../src/schema/migrate.js";
import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import { syncFile, type Space } from "../../src/server/lib/sync.js";
import {
  listEntities,
  listRedLinks,
  getEntity,
} from "../../src/server/lib/entities.js";

let workdir: string;
let dbPath: string;
const SPACE: Space = { name: "asset-test", watch_dir: "" };

// A 4-byte stub PNG header. Not a valid image, but the fs-watcher
// classifies by extension so this is enough to test asset-mode sync.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-asset-"));
  dbPath = join(workdir, "arke.db");
  SPACE.watch_dir = workdir;

  mkdirSync(join(workdir, "wiki"), { recursive: true });
  mkdirSync(join(workdir, "sources"), { recursive: true });
  mkdirSync(join(workdir, "images"), { recursive: true });

  await runMigrations({ dbPath });
  initDb(dbPath);

  const sql = createSql();
  await sql`INSERT INTO spaces(name, watch_dir) VALUES(${SPACE.name}, ${workdir})`;
});

afterEach(() => {
  closeDb();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("syncFile asset-mode", () => {
  it("creates an entity row with kind='asset' for a PNG", async () => {
    writeFileSync(join(workdir, "images/chart.png"), PNG_BYTES);

    const result = await syncFile(SPACE, "images/chart.png");

    expect(result.action).toBe("created");
    expect(result.type).toBe("file");
    expect(result.kind).toBe("asset");
    expect(result.label).toBe("chart");
    expect(result.linksExtracted).toBe(0);
  });

  it("populates properties with file_type and size_bytes", async () => {
    writeFileSync(join(workdir, "images/chart.png"), PNG_BYTES);
    await syncFile(SPACE, "images/chart.png");

    const entity = await getEntity(SPACE.name, "images/chart.png");
    expect(entity).not.toBeNull();
    expect(entity!.kind).toBe("asset");
    const props =
      typeof entity!.properties === "string"
        ? JSON.parse(entity!.properties)
        : entity!.properties;
    expect(props).toEqual({ file_type: "png", size_bytes: PNG_BYTES.length });
  });

  it("does not extract relationships for asset files", async () => {
    writeFileSync(join(workdir, "sources/doc.pdf"), Buffer.from("%PDF-1.4 fake"));
    await syncFile(SPACE, "sources/doc.pdf");

    const entity = await getEntity(SPACE.name, "sources/doc.pdf");
    expect(entity).not.toBeNull();
    expect(entity!.outbound).toEqual([]);
  });

  it("does NOT write an entity_edits audit row for assets", async () => {
    writeFileSync(join(workdir, "images/chart.png"), PNG_BYTES);
    await syncFile(SPACE, "images/chart.png");

    const sql = createSql();
    const edits = await sql`
      SELECT entity_path FROM entity_edits WHERE space_name = ${SPACE.name}
    `;
    expect(edits).toHaveLength(0);
  });

  it("text-mode source still gets a kind='text' row + entity_edits audit", async () => {
    writeFileSync(join(workdir, "sources/notes.txt"), "hello world");
    await syncFile(SPACE, "sources/notes.txt");

    const entity = await getEntity(SPACE.name, "sources/notes.txt");
    expect(entity!.kind).toBe("text");

    const sql = createSql();
    const edits = await sql`
      SELECT entity_path FROM entity_edits WHERE space_name = ${SPACE.name}
    `;
    expect(edits).toHaveLength(1);
  });
});

describe("link resolution: asset → no red link", () => {
  it("a wiki <img src> to an indexed asset resolves (no red-link row)", async () => {
    writeFileSync(join(workdir, "images/chart.png"), PNG_BYTES);
    writeFileSync(
      join(workdir, "wiki/article.html"),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>A</title></head>
<body><img src="../images/chart.png" alt="Chart"></body></html>`,
    );

    await syncFile(SPACE, "images/chart.png");
    await syncFile(SPACE, "wiki/article.html");

    const red = await listRedLinks({ space_name: SPACE.name });
    expect(red.redlinks).toHaveLength(0);

    // The relationship row exists (extractHtmlLinks walks <img src>),
    // but it isn't a red link because the asset has an entity row.
    const sql = createSql();
    const rels = await sql`
      SELECT source_path, target_path, link_text FROM relationships
      WHERE space_name = ${SPACE.name}
    `;
    expect(rels).toHaveLength(1);
    expect(rels[0].target_path).toBe("images/chart.png");
    expect(rels[0].link_text).toBe("Chart");
  });

  it("a wiki <a href> to an indexed asset also resolves (regression — non-image asset)", async () => {
    writeFileSync(join(workdir, "sources/doc.pdf"), Buffer.from("%PDF-1.4 fake"));
    writeFileSync(
      join(workdir, "wiki/article.html"),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>A</title></head>
<body><a href="../sources/doc.pdf">report</a></body></html>`,
    );

    await syncFile(SPACE, "sources/doc.pdf");
    await syncFile(SPACE, "wiki/article.html");

    const red = await listRedLinks({ space_name: SPACE.name });
    expect(red.redlinks).toHaveLength(0);
  });

  it("a wiki link to a never-synced asset IS a red link", async () => {
    writeFileSync(
      join(workdir, "wiki/article.html"),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>A</title></head>
<body><a href="../sources/missing.pdf">ref</a></body></html>`,
    );
    await syncFile(SPACE, "wiki/article.html");

    const red = await listRedLinks({ space_name: SPACE.name });
    expect(red.redlinks).toHaveLength(1);
    expect(red.redlinks[0].target_path).toBe("sources/missing.pdf");
  });
});

describe("listEntities kinds filter", () => {
  beforeEach(async () => {
    writeFileSync(join(workdir, "sources/a.txt"), "alpha");
    writeFileSync(join(workdir, "sources/b.md"), "# beta");
    writeFileSync(join(workdir, "images/c.png"), PNG_BYTES);
    writeFileSync(join(workdir, "sources/d.pdf"), Buffer.from("%PDF"));
    await syncFile(SPACE, "sources/a.txt");
    await syncFile(SPACE, "sources/b.md");
    await syncFile(SPACE, "images/c.png");
    await syncFile(SPACE, "sources/d.pdf");
  });

  it("kinds=['text'] returns only text rows", async () => {
    const r = await listEntities({
      space_name: SPACE.name,
      kinds: ["text"],
    });
    const paths = r.entities.map((e) => e.source_path).sort();
    expect(paths).toEqual(["sources/a.txt", "sources/b.md"]);
    for (const e of r.entities) expect(e.kind).toBe("text");
  });

  it("kinds=['asset'] returns only asset rows", async () => {
    const r = await listEntities({
      space_name: SPACE.name,
      kinds: ["asset"],
    });
    const paths = r.entities.map((e) => e.source_path).sort();
    expect(paths).toEqual(["images/c.png", "sources/d.pdf"]);
    for (const e of r.entities) expect(e.kind).toBe("asset");
  });

  it("no kind filter returns both", async () => {
    const r = await listEntities({ space_name: SPACE.name });
    expect(r.entities).toHaveLength(4);
  });

  it("kinds=['text','asset'] is equivalent to no filter", async () => {
    const r = await listEntities({
      space_name: SPACE.name,
      kinds: ["text", "asset"],
    });
    expect(r.entities).toHaveLength(4);
  });
});

describe("stat-fingerprint cache", () => {
  it("returns action='unchanged' on second sync of a never-touched file", async () => {
    writeFileSync(join(workdir, "sources/a.md"), "# alpha");
    const first = await syncFile(SPACE, "sources/a.md");
    expect(first.action).toBe("created");

    const second = await syncFile(SPACE, "sources/a.md");
    expect(second.action).toBe("unchanged");
  });

  it("returns action='unchanged' on second sync of an unchanged asset", async () => {
    writeFileSync(join(workdir, "images/c.png"), PNG_BYTES);
    const first = await syncFile(SPACE, "images/c.png");
    expect(first.action).toBe("created");

    const second = await syncFile(SPACE, "images/c.png");
    expect(second.action).toBe("unchanged");
  });

  it("touch without content change: returns unchanged, refreshes fingerprint, doesn't bump updated_at", async () => {
    writeFileSync(join(workdir, "sources/a.md"), "# alpha");
    await syncFile(SPACE, "sources/a.md");
    const before = await getEntity(SPACE.name, "sources/a.md");
    const beforeUpdatedAt = before!.updated_at;
    const beforeHash = before!.source_hash;

    // Touch: bump mtime forward 5 seconds while keeping bytes identical.
    const newTime = new Date(Date.now() + 5_000);
    utimesSync(join(workdir, "sources/a.md"), newTime, newTime);

    const result = await syncFile(SPACE, "sources/a.md");
    expect(result.action).toBe("unchanged");

    const after = await getEntity(SPACE.name, "sources/a.md");
    expect(after!.source_hash).toBe(beforeHash);
    expect(after!.updated_at).toBe(beforeUpdatedAt);
  });

  it("real content change: returns updated, source_hash shifts", async () => {
    writeFileSync(join(workdir, "sources/a.md"), "# alpha");
    await syncFile(SPACE, "sources/a.md");
    const before = await getEntity(SPACE.name, "sources/a.md");
    const beforeHash = before!.source_hash;

    writeFileSync(join(workdir, "sources/a.md"), "# alpha changed");
    const result = await syncFile(SPACE, "sources/a.md");
    expect(result.action).toBe("updated");

    const after = await getEntity(SPACE.name, "sources/a.md");
    expect(after!.source_hash).not.toBe(beforeHash);
  });

  it("real asset content change: returns updated, source_hash shifts", async () => {
    writeFileSync(join(workdir, "images/c.png"), PNG_BYTES);
    await syncFile(SPACE, "images/c.png");
    const before = await getEntity(SPACE.name, "images/c.png");
    const beforeHash = before!.source_hash;

    const altered = Buffer.concat([PNG_BYTES, Buffer.from([0xff])]);
    writeFileSync(join(workdir, "images/c.png"), altered);
    const result = await syncFile(SPACE, "images/c.png");
    expect(result.action).toBe("updated");

    const after = await getEntity(SPACE.name, "images/c.png");
    expect(after!.source_hash).not.toBe(beforeHash);
  });
});
