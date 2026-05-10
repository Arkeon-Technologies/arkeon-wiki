// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for `[[wikilink]]`-driven placeholder wikis.
 *
 * A placeholder is a wiki row with `source_hash IS NULL` — no file on
 * disk yet. The runtime exposes this as `unresolved: true` on listings
 * and direct lookups. Pre-006 these used to be a separate `type='stub'`,
 * which 006-collapse-stubs.sql merged into `type='wiki'` with the
 * source_hash signal.
 *
 * Covers:
 *   - bare `[[Label]]` creates a placeholder at `wiki/concept/<slug>.md`
 *   - typed `[[Label|subject_type]]` creates a placeholder at
 *     `wiki/<type>/<slug>.md`
 *   - editing a wiki to drop its [[wikilink]] GCs the placeholder when
 *     no other wiki points to it; preserves it when one still does
 *   - writing a real wiki at a placeholder's path upgrades the row in
 *     place, preserving inbound relationships
 *   - dangling standard markdown links do NOT create placeholders
 *     (warn-and-drop)
 *   - deleting the only wiki that points at a placeholder GCs it too
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";
import { getEntityBySourcePath, waitForEntityBySourcePath } from "./helpers.js";
import { createSql } from "../../src/server/lib/sql.js";

const API_PORT = 18793;
const BASE_URL = `http://localhost:${API_PORT}`;

let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceId: string;

function writeWiki(
  relativePath: string,
  properties: Record<string, unknown>,
  body: string,
): void {
  const absPath = join(testDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const fm = yaml
    .dump(properties, { schema: yaml.JSON_SCHEMA, sortKeys: false })
    .trimEnd();
  writeFileSync(absPath, `---\n${fm}\n---\n\n${body}\n`);
}

function deleteFile(relativePath: string): void {
  const absPath = join(testDir, relativePath);
  if (existsSync(absPath)) unlinkSync(absPath);
}

async function api(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (res.headers.get("content-type")?.includes("json")) return res.json();
  return res.text();
}

/**
 * Poll until an entity at a path either exists with the expected
 * resolution status, or until timeout. `kind='placeholder'` means
 * type='wiki' with no file on disk yet (unresolved=true). `kind='wiki'`
 * means a realized wiki (unresolved=false).
 */
async function waitForEntityKind(
  sourcePath: string,
  kind: "placeholder" | "wiki" | "file",
  timeoutMs = 5000,
): Promise<void> {
  const matches = (e: { type: "wiki" | "file"; unresolved: boolean }): boolean => {
    if (kind === "placeholder") return e.type === "wiki" && e.unresolved;
    if (kind === "wiki") return e.type === "wiki" && !e.unresolved;
    return e.type === "file";
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = await getEntityBySourcePath(spaceId, sourcePath);
    if (e && matches(e)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  const final = await getEntityBySourcePath(spaceId, sourcePath);
  throw new Error(
    `Timed out: entity at ${sourcePath} expected kind=${kind}, ` +
      `got ${final ? `type=${final.type} unresolved=${final.unresolved}` : "<missing>"}`,
  );
}

/** Poll until the entity at a path is gone. */
async function waitForEntityAbsent(sourcePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = await getEntityBySourcePath(spaceId, sourcePath);
    if (!e) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  const final = await getEntityBySourcePath(spaceId, sourcePath);
  if (final) {
    throw new Error(
      `Timed out: entity at ${sourcePath} still exists (type=${final.type})`,
    );
  }
}

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-stubs-${randomBytes(4).toString("hex")}`);
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
  serverHandle = { stop: async () => apiHandle.stop() };

  const data = await api("/spaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "stubs-test", watch_dir: testDir }),
  });
  spaceId = data.id;
}, 30_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), {
      recursive: true,
      force: true,
    });
  }
}, 30_000);

describe("[[wikilink]] → placeholder wiki", () => {
  it("a bare [[Label]] creates a placeholder at wiki/concept/<slug>.md", async () => {
    writeWiki(
      "wiki/concept/source-a.md",
      { label: "Source A", subject_type: "concept" },
      "References [[Information Theory]] heavily.",
    );

    const placeholder = await waitForEntityBySourcePath(
      spaceId,
      "wiki/concept/information-theory.md",
    );
    expect(placeholder.type).toBe("wiki");
    expect(placeholder.unresolved).toBe(true);
    expect(placeholder.label).toBe("Information Theory");

    // Nail down that source_hash is literally null (not "" or 0 or
    // undefined) — the placeholder predicate everywhere downstream
    // (gcOrphanedPlaceholders, the unresolved derived field, the
    // last-writer-wins guard in rebuildRelationships) gates on
    // `source_hash IS NULL` / `=== null`. A driver-side coercion to
    // empty string would silently break all of them.
    const sql = createSql();
    const raw = await sql`
      SELECT source_hash FROM entities WHERE id = ${placeholder.id}
    `;
    expect(raw[0].source_hash).toBeNull();

    // The wiki that referenced it should have an outbound relationship.
    const sourceA = await waitForEntityBySourcePath(
      spaceId,
      "wiki/concept/source-a.md",
    );
    const wiki = await api(`/entities/${sourceA.id}`);
    const out = wiki.relationships.outgoing;
    expect(out).toHaveLength(1);
    expect(out[0].target_id).toBe(placeholder.id);
    expect(out[0].link_text).toBe("Information Theory");
    expect(out[0].link_path).toBe("[[Information Theory]]");
  });

  it("a typed [[Label|subject_type]] creates a placeholder under wiki/<type>/<slug>.md", async () => {
    writeWiki(
      "wiki/concept/source-b.md",
      { label: "Source B", subject_type: "concept" },
      "Mentions [[Bell Labs|organization]] in passing.",
    );

    const placeholder = await waitForEntityBySourcePath(
      spaceId,
      "wiki/organization/bell-labs.md",
    );
    expect(placeholder.type).toBe("wiki");
    expect(placeholder.unresolved).toBe(true);
    expect(placeholder.label).toBe("Bell Labs");
  });

  it("two wikis pointing at the same [[Label]] share one placeholder with both inbound", async () => {
    writeWiki(
      "wiki/concept/source-c.md",
      { label: "Source C", subject_type: "concept" },
      "Discusses [[Shannon Sampling Theorem]].",
    );
    writeWiki(
      "wiki/concept/source-d.md",
      { label: "Source D", subject_type: "concept" },
      "Builds on [[Shannon Sampling Theorem]].",
    );

    const placeholder = await waitForEntityBySourcePath(
      spaceId,
      "wiki/concept/shannon-sampling-theorem.md",
    );
    expect(placeholder.unresolved).toBe(true);

    // Wait for both inbound relationships to arrive on the shared row.
    const deadline = Date.now() + 5000;
    let incomingCount = 0;
    while (Date.now() < deadline) {
      const entity = await api(`/entities/${placeholder.id}`);
      incomingCount = entity?.relationships?.incoming?.length ?? 0;
      if (incomingCount === 2) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(incomingCount).toBe(2);
  });

  it("editing a wiki to drop its [[wikilink]] GCs the placeholder when no other wiki points to it", async () => {
    writeWiki(
      "wiki/concept/source-e.md",
      { label: "Source E", subject_type: "concept" },
      "Mentions [[Lone Concept]] just once.",
    );

    await waitForEntityKind("wiki/concept/lone-concept.md", "placeholder");

    // Rewrite without the wikilink.
    writeWiki(
      "wiki/concept/source-e.md",
      { label: "Source E", subject_type: "concept" },
      "No more references to anything.",
    );

    await waitForEntityAbsent("wiki/concept/lone-concept.md");
  });

  it("writing a real wiki at a placeholder's path upgrades the row and preserves inbound", async () => {
    writeWiki(
      "wiki/concept/source-f.md",
      { label: "Source F", subject_type: "concept" },
      "Will eventually link to [[Quantum Computing]].",
    );

    const placeholder = await waitForEntityBySourcePath(
      spaceId,
      "wiki/concept/quantum-computing.md",
    );
    expect(placeholder.unresolved).toBe(true);
    const placeholderId = placeholder.id;

    // Now write the real wiki at the same path. The id should be preserved
    // (entity-by-source_path lookup finds the row and UPDATEs it in place).
    writeWiki(
      "wiki/concept/quantum-computing.md",
      { label: "Quantum Computing", subject_type: "concept" },
      "Real content for the quantum-computing wiki.",
    );

    await waitForEntityKind("wiki/concept/quantum-computing.md", "wiki");

    const upgraded = await getEntityBySourcePath(
      spaceId,
      "wiki/concept/quantum-computing.md",
    );
    expect(upgraded?.type).toBe("wiki");
    expect(upgraded?.unresolved).toBe(false);
    expect(upgraded?.id).toBe(placeholderId); // id preserved across upgrade

    // Source F's outbound link should still resolve to the upgraded row.
    const sourceF = await getEntityBySourcePath(
      spaceId,
      "wiki/concept/source-f.md",
    );
    const wiki = await api(`/entities/${sourceF!.id}`);
    const linksToQc = wiki.relationships.outgoing.filter(
      (r: any) => r.target_id === placeholderId,
    );
    expect(linksToQc).toHaveLength(1);
  });

  it("a dangling standard markdown link does NOT create a placeholder (warn-and-drop)", async () => {
    writeWiki(
      "wiki/concept/source-g.md",
      { label: "Source G", subject_type: "concept" },
      "Has a typo'd [missing target](../concept/totally-fake.md) link.",
    );

    const sourceG = await waitForEntityBySourcePath(
      spaceId,
      "wiki/concept/source-g.md",
    );
    // Give the watcher a moment to (not) create a placeholder.
    await new Promise((r) => setTimeout(r, 800));

    const fake = await getEntityBySourcePath(
      spaceId,
      "wiki/concept/totally-fake.md",
    );
    expect(fake).toBeNull();

    const wiki = await api(`/entities/${sourceG.id}`);
    expect(wiki.relationships.outgoing).toHaveLength(0);
  });

  it("deleting the only wiki pointing at a placeholder GCs it", async () => {
    writeWiki(
      "wiki/concept/source-h.md",
      { label: "Source H", subject_type: "concept" },
      "Solo reference to [[Disposable Concept]].",
    );

    await waitForEntityKind("wiki/concept/disposable-concept.md", "placeholder");

    deleteFile("wiki/concept/source-h.md");

    await waitForEntityAbsent("wiki/concept/disposable-concept.md");
  });
});
