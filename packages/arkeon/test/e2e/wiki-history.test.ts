// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for GET /entities/:id/history.
 *
 * Builds up a wiki via several applyEdit calls (different roles +
 * edit_kinds), then verifies the audit endpoint returns them
 * newest-first with the right shape, supports the `role` and `since`
 * filters, and 404s on unknown ids.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { applyEdit } from "../../src/server/lib/file-edits.js";
import { closeDb, createSql } from "../../src/server/lib/sql.js";
import { generateUlid } from "../../src/server/lib/ids.js";
import { runMigrations } from "../../src/schema/index.js";

let testDir: string;
let stateDir: string;
let space: { id: string; name: string; watch_dir: string };
let baseUrl: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let entityId: string;
let prevEmbeddingsEnv: string | undefined;
let prevChunkingEnv: string | undefined;

beforeAll(async () => {
  // Save before mutating — vitest e2e config has isolate: false, so
  // sibling suites in the same process share process.env.
  prevEmbeddingsEnv = process.env.ARKEON_WIKI_EMBEDDINGS;
  prevChunkingEnv = process.env.ARKEON_WIKI_CHUNKING;
  process.env.ARKEON_WIKI_EMBEDDINGS = "0";
  process.env.ARKEON_WIKI_CHUNKING = "0";

  const base = join(tmpdir(), `arkeon-wiki-history-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "wiki", "person"), { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });

  process.env.DATABASE_PATH = join(stateDir, "data", "arke.db");
  await runMigrations({ dbPath: process.env.DATABASE_PATH });

  space = { id: generateUlid(), name: "wiki-history-test", watch_dir: testDir };
  const sql = createSql();
  await sql`INSERT INTO spaces (id, name, watch_dir) VALUES (${space.id}, ${space.name}, ${space.watch_dir})`;

  // Three edits to the same wiki, attributed to different roles.
  const create = await applyEdit(
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
    { role: "ingestor", edit_kind: "create", note: "initial import" },
  );
  if (create.kind !== "write") throw new Error("expected write");
  entityId = create.sync.entityId;

  // Tiny delay so the `at` timestamps are distinct.
  await new Promise((r) => setTimeout(r, 1100));

  await applyEdit(
    space,
    {
      kind: "edit",
      path: "wiki/person/shannon.md",
      search: "father of information theory",
      replace: "father of information theory and a Bell Labs engineer",
    },
    { role: "synthesizer", edit_kind: "replace", note: "fold in occupation" },
  );

  await new Promise((r) => setTimeout(r, 1100));

  await applyEdit(
    space,
    {
      kind: "edit",
      path: "wiki/person/shannon.md",
      search: "Bell Labs engineer",
      replace: "Bell Labs engineer who invented information theory",
    },
    { role: "synthesizer", edit_kind: "replace", note: "expand" },
  );

  // Start an in-process API server so we can fetch the route.
  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: 0, dbPath: process.env.DATABASE_PATH });
  baseUrl = `http://localhost:${apiHandle.address.port}`;
  serverHandle = { stop: () => apiHandle.stop() };
}, 30_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
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

interface HistoryRow {
  id: number;
  by_role: string;
  edit_kind: string;
  edit_note: string | null;
  content_hash: string;
  at: string;
}

describe("GET /entities/:id/history", () => {
  it("returns all edits newest-first with the expected shape", async () => {
    const res = await fetch(`${baseUrl}/entities/${entityId}/history`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entity_id: string; edits: HistoryRow[] };
    expect(json.entity_id).toBe(entityId);
    expect(json.edits).toHaveLength(3);
    // Newest first.
    expect(json.edits[0].edit_note).toBe("expand");
    expect(json.edits[1].edit_note).toBe("fold in occupation");
    expect(json.edits[2].edit_note).toBe("initial import");
    expect(json.edits[2].by_role).toBe("ingestor");
    expect(json.edits[2].edit_kind).toBe("create");
  });

  it("respects ?role= filter", async () => {
    const res = await fetch(`${baseUrl}/entities/${entityId}/history?role=synthesizer`);
    const json = (await res.json()) as { edits: HistoryRow[] };
    expect(json.edits).toHaveLength(2);
    for (const e of json.edits) expect(e.by_role).toBe("synthesizer");
  });

  it("respects ?since= filter", async () => {
    const all = await (
      await fetch(`${baseUrl}/entities/${entityId}/history`)
    ).json() as { edits: HistoryRow[] };
    const middle = all.edits[1].at;
    const res = await fetch(
      `${baseUrl}/entities/${entityId}/history?since=${encodeURIComponent(middle)}`,
    );
    const json = (await res.json()) as { edits: HistoryRow[] };
    // since is at-or-after, so two edits qualify.
    expect(json.edits).toHaveLength(2);
  });

  it("404s on an unknown wiki id", async () => {
    const res = await fetch(`${baseUrl}/entities/01NOPE/history`);
    expect(res.status).toBe(404);
  });

  it("clamps ?limit= to MAX_LIMIT", async () => {
    const res = await fetch(`${baseUrl}/entities/${entityId}/history?limit=99999`);
    const json = (await res.json()) as { edits: HistoryRow[] };
    // We have 3 edits so this just confirms we get them all without erroring.
    expect(json.edits).toHaveLength(3);
  });
});
