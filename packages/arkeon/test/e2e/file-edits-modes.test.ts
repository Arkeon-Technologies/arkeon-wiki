// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the new edit_file modes added in issue #94:
 * `annotate` and `delete_section`. The CREATE/APPEND/REPLACE round-
 * trips already have coverage in edit-log.test.ts; this file is
 * focused on the two new modes plus their entity_edits attribution.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { applyEdit } from "../../src/server/lib/file-edits.js";
import { closeDb, createSql } from "../../src/server/lib/sql.js";
import { runMigrations } from "../../src/schema/index.js";
import { generateUlid } from "../../src/server/lib/ids.js";

let testDir: string;
let stateDir: string;
let space: { id: string; name: string; watch_dir: string };
let prevEmbeddingsEnv: string | undefined;
let prevChunkingEnv: string | undefined;

beforeAll(async () => {
  prevEmbeddingsEnv = process.env.ARKEON_WIKI_EMBEDDINGS;
  prevChunkingEnv = process.env.ARKEON_WIKI_CHUNKING;
  process.env.ARKEON_WIKI_EMBEDDINGS = "0";
  process.env.ARKEON_WIKI_CHUNKING = "0";

  const base = join(tmpdir(), `arkeon-edit-modes-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "wiki", "person"), { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });

  process.env.DATABASE_PATH = join(stateDir, "data", "arke.db");
  await runMigrations({ dbPath: process.env.DATABASE_PATH });

  space = {
    id: generateUlid(),
    name: "edit-modes-test",
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
  if (prevEmbeddingsEnv === undefined) delete process.env.ARKEON_WIKI_EMBEDDINGS;
  else process.env.ARKEON_WIKI_EMBEDDINGS = prevEmbeddingsEnv;
  if (prevChunkingEnv === undefined) delete process.env.ARKEON_WIKI_CHUNKING;
  else process.env.ARKEON_WIKI_CHUNKING = prevChunkingEnv;
}, 10_000);

const seedWiki = async (path: string, body: string) => {
  await applyEdit(
    space,
    { kind: "write", path, content: body },
    { role: "ingestor", edit_kind: "create" },
  );
};

describe("edit_file mode='annotate'", () => {
  it("splices insert_text after the unique anchor and preserves the rest verbatim", async () => {
    const path = "wiki/person/turing.md";
    const seed = [
      "---",
      "label: Alan Turing",
      "subject_type: person",
      "---",
      "",
      "Alan Turing was a British mathematician.",
      "",
      "He worked on codebreaking during the war.",
      "",
    ].join("\n");
    await seedWiki(path, seed);

    const result = await applyEdit(
      space,
      {
        kind: "annotate",
        path,
        insert_after_phrase: "British mathematician",
        insert_text: " and computer scientist",
      },
      { role: "ingestor", edit_kind: "annotate", note: "fold in field" },
    );
    expect(result.kind).toBe("annotate");

    const onDisk = readFileSync(join(testDir, path), "utf-8");
    expect(onDisk).toContain(
      "Alan Turing was a British mathematician and computer scientist.",
    );
    // The trailing paragraph is byte-identical.
    expect(onDisk).toContain("He worked on codebreaking during the war.");

    // Frontmatter stamped with the role.
    expect(onDisk).toContain("edited_by: ingestor");
    expect(onDisk).toContain("edit_note: fold in field");

    // entity_edits row attributed to annotate.
    const sql = createSql();
    if (result.kind !== "annotate") throw new Error("expected annotate");
    const rows = (await sql`
      SELECT by_role, edit_kind FROM entity_edits
      WHERE entity_id = ${result.sync.entityId}
      ORDER BY id DESC LIMIT 1
    `) as { by_role: string; edit_kind: string }[];
    expect(rows[0].by_role).toBe("ingestor");
    expect(rows[0].edit_kind).toBe("annotate");
  });

  it("throws when the anchor phrase is not present", async () => {
    const path = "wiki/person/turing.md";
    await expect(
      applyEdit(
        space,
        {
          kind: "annotate",
          path,
          insert_after_phrase: "definitely not in the file",
          insert_text: "junk",
        },
        { role: "ingestor", edit_kind: "annotate" },
      ),
    ).rejects.toThrow(/did not match/);
  });

  it("refuses to splice when the anchor phrase falls inside YAML frontmatter", async () => {
    // Picking a unique frontmatter line as the anchor would corrupt the
    // YAML on the next sync. Annotate writes to the body only.
    const path = "wiki/person/fm-anchor.md";
    await seedWiki(
      path,
      [
        "---",
        "label: FM Anchor",
        "subject_type: person",
        "fields_of_work: mathematics",
        "---",
        "",
        "Body paragraph.",
        "",
      ].join("\n"),
    );
    await expect(
      applyEdit(
        space,
        {
          kind: "annotate",
          path,
          insert_after_phrase: "subject_type: person",
          insert_text: "\nfraudulent_extra: true",
        },
        { role: "ingestor", edit_kind: "annotate" },
      ),
    ).rejects.toThrow(/inside YAML frontmatter/);
  });

  it("throws when the anchor phrase appears more than once", async () => {
    const path = "wiki/person/dup.md";
    await seedWiki(
      path,
      [
        "---",
        "label: Dup",
        "subject_type: person",
        "---",
        "",
        "He worked on it. He worked on it.",
        "",
      ].join("\n"),
    );
    await expect(
      applyEdit(
        space,
        {
          kind: "annotate",
          path,
          insert_after_phrase: "He worked on it.",
          insert_text: " (twice!)",
        },
        { role: "ingestor", edit_kind: "annotate" },
      ),
    ).rejects.toThrow(/matched 2 times/);
  });
});

describe("edit_file mode='delete_section'", () => {
  it("removes an ATX heading and its body up to the next same-or-higher heading", async () => {
    const path = "wiki/person/shannon.md";
    await seedWiki(
      path,
      [
        "---",
        "label: Claude Shannon",
        "subject_type: person",
        "---",
        "",
        "Lead paragraph about Shannon.",
        "",
        "## Information theory",
        "",
        "Body about information theory.",
        "",
        "## Open threads",
        "",
        "- Birth year is uncertain",
        "- Need a citation for Bell Labs tenure",
        "",
        "## Bell Labs",
        "",
        "Body about Bell Labs.",
        "",
      ].join("\n"),
    );

    const result = await applyEdit(
      space,
      { kind: "delete_section", path, heading: "## Open threads" },
      { role: "consolidator", edit_kind: "delete_section", note: "threads resolved" },
    );
    expect(result.kind).toBe("delete_section");

    const onDisk = readFileSync(join(testDir, path), "utf-8");
    expect(onDisk).not.toContain("Open threads");
    expect(onDisk).not.toContain("Birth year is uncertain");
    expect(onDisk).toContain("## Information theory");
    expect(onDisk).toContain("Body about information theory.");
    expect(onDisk).toContain("## Bell Labs");
    expect(onDisk).toContain("Body about Bell Labs.");

    // Frontmatter stamped with the role.
    expect(onDisk).toContain("edited_by: consolidator");
    expect(onDisk).toContain("edit_note: threads resolved");

    if (result.kind !== "delete_section") throw new Error("expected delete_section");
    const sql = createSql();
    const rows = (await sql`
      SELECT by_role, edit_kind FROM entity_edits
      WHERE entity_id = ${result.sync.entityId}
      ORDER BY id DESC LIMIT 1
    `) as { by_role: string; edit_kind: string }[];
    expect(rows[0].by_role).toBe("consolidator");
    expect(rows[0].edit_kind).toBe("delete_section");
  });

  it("throws when the heading is not present", async () => {
    const path = "wiki/person/shannon.md";
    await expect(
      applyEdit(
        space,
        { kind: "delete_section", path, heading: "## Phantom heading" },
        { role: "consolidator", edit_kind: "delete_section" },
      ),
    ).rejects.toThrow(/did not match/);
  });
});
