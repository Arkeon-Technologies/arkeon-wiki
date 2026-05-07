// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for the chunking pipeline (issue #47).
 *
 * Flips ARKEON_WIKI_CHUNKING=1 before starting its own server, writes a
 * wiki, waits for the watcher, and asserts that entity_chunks is
 * populated correctly. With chunking off (default), the existing
 * fs-sync.test.ts already covers the no-chunks behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { createSql } from "../../src/server/lib/sql.js";
import { waitForEntityBySourcePath } from "./helpers.js";

const API_PORT = 18790;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;
let prevChunkingEnv: string | undefined;

function writeWiki(
  relativePath: string,
  properties: Record<string, unknown>,
  body: string,
): void {
  const absPath = join(testDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const fm = yaml.dump(properties, { schema: yaml.JSON_SCHEMA, sortKeys: false }).trimEnd();
  writeFileSync(absPath, `---\n${fm}\n---\n\n${body}\n`);
}

interface ChunkRow {
  chunk_index: number;
  chunk_kind: string;
  heading_path: string;
  text: string;
  content_hash: string;
}

async function getChunks(entityId: string): Promise<ChunkRow[]> {
  const sql = createSql();
  const rows = await sql`
    SELECT chunk_index, chunk_kind, heading_path, text, content_hash
    FROM entity_chunks
    WHERE entity_id = ${entityId}
    ORDER BY chunk_index
  `;
  return rows as ChunkRow[];
}

async function waitForChunks(
  entityId: string,
  predicate: (rows: ChunkRow[]) => boolean,
  timeoutMs = 5000,
): Promise<ChunkRow[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await getChunks(entityId);
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getChunks(entityId);
}

beforeAll(async () => {
  prevChunkingEnv = process.env.ARKEON_WIKI_CHUNKING;
  process.env.ARKEON_WIKI_CHUNKING = "1";

  const base = join(tmpdir(), `arkeon-chunks-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });

  process.env.ARKEON_WIKI_HOME = stateDir;

  const dbFile = join(stateDir, "data", "arke.db");

  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: API_PORT, dbPath: dbFile });
  serverHandle = { stop: () => apiHandle.stop() };

  const res = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "chunks-test", watch_dir: testDir }),
  });
  const data = await res.json() as { id: string };
  spaceId = data.id;
}, 60_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), { recursive: true, force: true });
  }
  if (prevChunkingEnv === undefined) {
    delete process.env.ARKEON_WIKI_CHUNKING;
  } else {
    process.env.ARKEON_WIKI_CHUNKING = prevChunkingEnv;
  }
}, 30_000);

describe("entity_chunks (ARKEON_WIKI_CHUNKING=1)", () => {
  it("populates a card + section chunks for a synced wiki", async () => {
    writeWiki("wiki/person/shannon.md", {
      label: "Claude Shannon",
      subject_type: "person",
      aliases: ["C. E. Shannon"],
      short_description: "American mathematician, father of information theory.",
    }, [
      "Claude Shannon was an American mathematician.",
      "",
      "## Early Life",
      "",
      "Born in 1916 in Michigan.",
      "",
      "## Career",
      "",
      "Worked at Bell Labs.",
    ].join("\n"));

    const entity = await waitForEntityBySourcePath(spaceId, "wiki/person/shannon.md");
    const chunks = await waitForChunks(entity.id, (rows) => rows.length === 3);

    expect(chunks.map((c) => c.chunk_kind)).toEqual(["card", "section", "section"]);
    expect(chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2]);

    expect(chunks[0].heading_path).toBe("Claude Shannon");
    expect(chunks[0].text).toContain("Claude Shannon (person)");
    expect(chunks[0].text).toContain("Aliases: C. E. Shannon");
    expect(chunks[0].text).toContain("father of information theory");

    expect(chunks[1].heading_path).toBe("Claude Shannon > Early Life");
    expect(chunks[1].text.startsWith("Claude Shannon > Early Life\n\n")).toBe(true);
    expect(chunks[1].text).toContain("Born in 1916 in Michigan.");

    expect(chunks[2].heading_path).toBe("Claude Shannon > Career");
    expect(chunks[2].text).toContain("Worked at Bell Labs.");

    for (const c of chunks) {
      expect(c.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("replaces chunks on edit (no orphans, new content_hash)", async () => {
    const entity = await waitForEntityBySourcePath(spaceId, "wiki/person/shannon.md");
    const before = await getChunks(entity.id);
    const earlyLifeBefore = before.find((c) => c.heading_path === "Claude Shannon > Early Life")!;

    writeWiki("wiki/person/shannon.md", {
      id: entity.id,
      label: "Claude Shannon",
      subject_type: "person",
      aliases: ["C. E. Shannon"],
      short_description: "American mathematician, father of information theory.",
    }, [
      "Claude Shannon was an American mathematician.",
      "",
      "## Early Life",
      "",
      "Born in 1916 in Petoskey, Michigan.",
      "",
      "## Career",
      "",
      "Worked at Bell Labs.",
    ].join("\n"));

    const after = await waitForChunks(
      entity.id,
      (rows) => {
        const el = rows.find((c) => c.heading_path === "Claude Shannon > Early Life");
        return !!el && el.content_hash !== earlyLifeBefore.content_hash;
      },
    );

    expect(after).toHaveLength(3);
    const earlyLifeAfter = after.find((c) => c.heading_path === "Claude Shannon > Early Life")!;
    expect(earlyLifeAfter.text).toContain("Petoskey, Michigan");
    expect(earlyLifeAfter.content_hash).not.toBe(earlyLifeBefore.content_hash);
  });

  it("does not chunk source (non-wiki) files", async () => {
    const sourcePath = "notes/meeting.txt";
    const absPath = join(testDir, sourcePath);
    mkdirSync(absPath.substring(0, absPath.lastIndexOf("/")), { recursive: true });
    writeFileSync(absPath, "Meeting notes from today.");

    const entity = await waitForEntityBySourcePath(spaceId, sourcePath);
    expect(entity.type).toBe("file");

    // Watcher is async; give it time to (not) chunk this.
    await new Promise((r) => setTimeout(r, 800));
    const chunks = await getChunks(entity.id);
    expect(chunks).toHaveLength(0);
  });

  it("cascades chunk deletion when the entity is deleted", async () => {
    writeWiki("wiki/person/temp.md", {
      label: "Temp Wiki",
      subject_type: "person",
    }, "## Section\n\nBody.");

    const entity = await waitForEntityBySourcePath(spaceId, "wiki/person/temp.md");
    await waitForChunks(entity.id, (rows) => rows.length > 0);

    const res = await fetch(`${BASE_URL}/entities/${entity.id}`, { method: "DELETE" });
    expect((await res.json() as { deleted: boolean }).deleted).toBe(true);

    const after = await getChunks(entity.id);
    expect(after).toHaveLength(0);
  });
});
