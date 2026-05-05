// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for the entity_edits audit log (the foundation of
 * the contribute → synthesize cascade).
 *
 * Exercises:
 *   - applyEdit with a worker role stamps the file's frontmatter and
 *     produces an entity_edits row attributed to that role
 *   - A human edit (sync of a file change without an edit-context
 *     registration) produces an entity_edits row attributed to "human"
 *   - The watcher's post-write sync of a file applyEdit just wrote
 *     does not double-insert (uniqueness on (entity_id, content_hash))
 *   - The entity_latest_edit view returns the most recent row
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { applyEdit } from "../../src/server/lib/file-edits.js";
import { syncFile } from "../../src/server/lib/sync.js";
import { closeDb, createSql } from "../../src/server/lib/sql.js";
import { runMigrations } from "../../src/schema/index.js";
import { generateUlid } from "../../src/server/lib/ids.js";

let testDir: string;
let stateDir: string;
let space: { id: string; name: string; watch_dir: string };

beforeAll(async () => {
  // Disable embeddings + chunking — we don't need them for the audit
  // log shape, and they pull in the bundled ONNX runtime.
  process.env.ARKEON_WIKI_EMBEDDINGS = "0";
  process.env.ARKEON_WIKI_CHUNKING = "0";

  const base = join(tmpdir(), `arkeon-edit-log-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "wiki", "person"), { recursive: true });
  mkdirSync(join(testDir, "sources"), { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });

  process.env.DATABASE_PATH = join(stateDir, "data", "arke.db");
  await runMigrations({ dbPath: process.env.DATABASE_PATH });

  space = {
    id: generateUlid(),
    name: "edit-log-test",
    watch_dir: testDir,
  };

  const sql = createSql();
  await sql`INSERT INTO spaces (id, name, watch_dir) VALUES (${space.id}, ${space.name}, ${space.watch_dir})`;
}, 30_000);

afterAll(async () => {
  closeDb();
  if (testDir) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
}, 10_000);

describe("entity_edits audit log", () => {
  it("applyEdit (CREATE) stamps frontmatter and inserts a row attributed to the role", async () => {
    const result = await applyEdit(
      space,
      {
        kind: "write",
        path: "wiki/person/shannon.md",
        content: [
          "---",
          "label: Claude Shannon",
          "subject_type: person",
          "---",
          "",
          "Claude Shannon was the father of information theory.",
          "",
        ].join("\n"),
      },
      { role: "ingestor", edit_kind: "create", note: "first import from shannon-bio" },
    );

    expect(result.kind).toBe("write");
    if (result.kind !== "write") throw new Error("expected write");

    // Frontmatter on disk has edited_by + edit_note
    const onDisk = readFileSync(
      join(testDir, "wiki/person/shannon.md"),
      "utf-8",
    );
    expect(onDisk).toContain("edited_by: ingestor");
    expect(onDisk).toContain("edit_note: first import from shannon-bio");

    // entity_edits has one row attributed to ingestor
    const sql = createSql();
    const rows = await sql`
      SELECT by_role, edit_kind, edit_note FROM entity_edits
      WHERE entity_id = ${result.sync.entityId}
      ORDER BY id ASC
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].by_role).toBe("ingestor");
    expect(rows[0].edit_kind).toBe("create");
    expect(rows[0].edit_note).toBe("first import from shannon-bio");
  });

  it("a watcher resync of the same content does not double-insert", async () => {
    const sql = createSql();
    const before = await sql`SELECT COUNT(*) AS c FROM entity_edits` as { c: number }[];

    // Simulate a watcher firing: syncFile with no edit-context registered.
    // The file content hasn't changed, so syncFile returns "unchanged" and
    // the recordEdit path isn't entered at all.
    await syncFile(space, "wiki/person/shannon.md");

    const after = await sql`SELECT COUNT(*) AS c FROM entity_edits` as { c: number }[];
    expect(after[0].c).toBe(before[0].c);
  });

  it("applyEdit (REPLACE) inserts a new row attributed to the role", async () => {
    const sql = createSql();
    const before = await sql`SELECT COUNT(*) AS c FROM entity_edits` as { c: number }[];

    const result = await applyEdit(
      space,
      {
        kind: "edit",
        path: "wiki/person/shannon.md",
        search: "father of information theory",
        replace: "father of information theory and a Bell Labs engineer",
      },
      { role: "synthesizer", edit_kind: "replace", note: "fold in occupation" },
    );

    expect(result.kind).toBe("edit");
    if (result.kind !== "edit") throw new Error("expected edit");

    const after = await sql`SELECT COUNT(*) AS c FROM entity_edits` as { c: number }[];
    expect(after[0].c).toBe(before[0].c + 1);

    const latest = await sql`
      SELECT by_role, edit_kind, edit_note FROM entity_edits
      WHERE entity_id = ${result.sync.entityId}
      ORDER BY id DESC LIMIT 1
    ` as { by_role: string; edit_kind: string; edit_note: string }[];
    expect(latest[0].by_role).toBe("synthesizer");
    expect(latest[0].edit_kind).toBe("replace");
    expect(latest[0].edit_note).toBe("fold in occupation");

    // Frontmatter now reflects the latest writer.
    const onDisk = readFileSync(
      join(testDir, "wiki/person/shannon.md"),
      "utf-8",
    );
    expect(onDisk).toContain("edited_by: synthesizer");
  });

  it("a filesystem-only change (no applyEdit) is attributed to 'human'", async () => {
    // Simulate a human editing the file in their text editor: write
    // directly without going through applyEdit, so no edit-context is
    // registered. The frontmatter still says edited_by: synthesizer
    // from the previous test — that's fine, the system uses the
    // registry, not the frontmatter, as the attribution source of truth.
    const path = "wiki/person/shannon.md";
    const onDisk = readFileSync(join(testDir, path), "utf-8");
    const tampered = onDisk + "\nA human added this trailing line.\n";
    writeFileSync(join(testDir, path), tampered, "utf-8");

    const result = await syncFile(space, path);
    expect(result.action).toBe("updated");

    const sql = createSql();
    const latest = await sql`
      SELECT by_role, edit_kind FROM entity_edits
      WHERE entity_id = ${result.entityId}
      ORDER BY id DESC LIMIT 1
    ` as { by_role: string; edit_kind: string }[];
    expect(latest[0].by_role).toBe("human");
    expect(latest[0].edit_kind).toBe("resync");
  });

  it("entity_latest_edit view returns the most recent row per entity", async () => {
    const sql = createSql();
    const rows = await sql`
      SELECT entity_id, last_edited_by, last_edit_kind FROM entity_latest_edit
    ` as { entity_id: string; last_edited_by: string; last_edit_kind: string }[];
    // After the four edits above (create + replace + human resync), the
    // most recent for shannon.md should be the human resync.
    const shannon = rows.find(
      (r) => r.last_edited_by === "human" || r.last_edited_by === "synthesizer",
    );
    expect(shannon?.last_edited_by).toBe("human");
    expect(shannon?.last_edit_kind).toBe("resync");
  });

  it("a source file (non-md, non-wiki) gets attributed too", async () => {
    // Source files don't have frontmatter, so no stamp happens, but
    // entity_edits should still record the import.
    writeFileSync(
      join(testDir, "sources/shannon-bio.txt"),
      "Bio text about Claude Shannon.",
      "utf-8",
    );
    const result = await syncFile(space, "sources/shannon-bio.txt");

    const sql = createSql();
    const latest = await sql`
      SELECT by_role, edit_kind FROM entity_edits
      WHERE entity_id = ${result.entityId}
      ORDER BY id DESC LIMIT 1
    ` as { by_role: string; edit_kind: string }[];
    expect(latest).toHaveLength(1);
    expect(latest[0].by_role).toBe("human");
    expect(latest[0].edit_kind).toBe("resync");
  });
});
