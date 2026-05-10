// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for cross-space wikilinks (issue #101).
 *
 * Spins up two spaces side-by-side. Wikis in space-A use the
 * `[[Label|subject_type|space:space-b]]` form to point at wikis in
 * space-B. Resolver behavior under test:
 *
 *   - resolves to an existing peer-space wiki and creates an edge across
 *     the space boundary
 *   - cross-space links pointing at a non-existent target warn-and-drop
 *     and do NOT create a placeholder in the peer space (writes always
 *     stay scoped to the source's own space)
 *   - cross-space links to an unknown space name warn-and-drop
 *   - same-space wikilinks still create placeholders in the source space
 *     (regression guard for the parser change)
 *   - link_path stores the literal `[[...|space:...]]` form so consumers
 *     can detect cross-space edges via the `space:` substring
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { getEntityBySourcePath, waitForEntityBySourcePath } from "./helpers.js";
import { createSql } from "../../src/server/lib/sql.js";

const API_PORT = 18799;
const BASE_URL = `http://localhost:${API_PORT}`;

let baseDir: string;
let dirA: string;
let dirB: string;
let dirDup: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;
let spaceAId: string;
let spaceBId: string;
// Second space registered under the same `name='space-b'` so the
// resolver's ambiguity branch has something to trip over. Different
// watch_dir (the schema's UNIQUE constraint is on watch_dir, not name).
let spaceDupId: string;

let prevChunkingEnv: string | undefined;
let prevEmbeddingsEnv: string | undefined;

function writeWiki(
  dir: string,
  relativePath: string,
  fmYaml: string,
  body: string,
): void {
  const absPath = join(dir, relativePath);
  const parent = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(absPath, `---\n${fmYaml}---\n\n${body}\n`);
}

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (res.headers.get("content-type")?.includes("json")) return res.json();
  return res.text();
}

async function getOutgoingByLinkText(
  sourceId: string,
  linkText: string,
): Promise<{
  target_id: string;
  target_space_id: string;
  target_source_path: string;
  link_path: string;
} | null> {
  const sql = createSql();
  const rows = await sql`
    SELECT r.target_id, r.link_path,
           t.space_id AS target_space_id,
           t.source_path AS target_source_path
    FROM relationships r
    JOIN entities t ON t.id = r.target_id
    WHERE r.source_id = ${sourceId} AND r.link_text = ${linkText}
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    target_id: row.target_id as string,
    target_space_id: row.target_space_id as string,
    target_source_path: row.target_source_path as string,
    link_path: row.link_path as string,
  };
}

beforeAll(async () => {
  baseDir = join(tmpdir(), `arkeon-cross-space-${randomBytes(4).toString("hex")}`);
  dirA = join(baseDir, "space-a");
  dirB = join(baseDir, "space-b");
  dirDup = join(baseDir, "space-b-duplicate");
  stateDir = join(baseDir, "state");
  for (const d of [dirA, dirB, dirDup, join(stateDir, "data")]) {
    mkdirSync(d, { recursive: true });
  }

  process.env.ARKEON_WIKI_HOME = stateDir;
  prevChunkingEnv = process.env.ARKEON_WIKI_CHUNKING;
  prevEmbeddingsEnv = process.env.ARKEON_WIKI_EMBEDDINGS;
  process.env.ARKEON_WIKI_CHUNKING = "0";
  process.env.ARKEON_WIKI_EMBEDDINGS = "0";

  const dbFile = join(stateDir, "data", "arke.db");
  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  // Pre-seed space-b with a wiki BEFORE registering, so the initial-
  // scan picks it up and cross-space resolves from space-a can find it
  // on first sync.
  writeWiki(
    dirB,
    "wiki/organization/bell-labs.md",
    "label: Bell Labs\nsubject_type: organization\n",
    "Industrial research lab.",
  );

  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: API_PORT, dbPath: dbFile });
  serverHandle = { stop: async () => apiHandle.stop() };

  // Register both spaces. Space-a is registered second so the wikis
  // we'll write in it during the tests fire watcher events post-init.
  const resB = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "space-b", watch_dir: dirB }),
  });
  spaceBId = ((await resB.json()) as { id: string }).id;

  const resA = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "space-a", watch_dir: dirA }),
  });
  spaceAId = ((await resA.json()) as { id: string }).id;

  // Confirm Bell Labs is indexed in space-b before any test runs.
  await waitForEntityBySourcePath(spaceBId, "wiki/organization/bell-labs.md");
}, 30_000);

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  if (baseDir && existsSync(baseDir)) {
    rmSync(baseDir, { recursive: true, force: true });
  }
  if (prevChunkingEnv === undefined) delete process.env.ARKEON_WIKI_CHUNKING;
  else process.env.ARKEON_WIKI_CHUNKING = prevChunkingEnv;
  if (prevEmbeddingsEnv === undefined) delete process.env.ARKEON_WIKI_EMBEDDINGS;
  else process.env.ARKEON_WIKI_EMBEDDINGS = prevEmbeddingsEnv;
}, 30_000);

describe("cross-space [[wikilink|space:NAME]]", () => {
  it("resolves to an existing peer-space wiki and emits a cross-space edge", async () => {
    writeWiki(
      dirA,
      "wiki/concept/shannon.md",
      "label: Claude Shannon\nsubject_type: person\n",
      "Worked at [[Bell Labs|organization|space:space-b]] in the 40s.",
    );

    const sourceA = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/shannon.md",
    );

    // Poll until the cross-space edge lands. Multi-space resolution runs
    // synchronously inside the sync transaction, but the watcher itself
    // is debounced.
    const deadline = Date.now() + 5000;
    let edge: Awaited<ReturnType<typeof getOutgoingByLinkText>> = null;
    while (Date.now() < deadline) {
      edge = await getOutgoingByLinkText(sourceA.id, "Bell Labs");
      if (edge) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(edge).not.toBeNull();

    expect(edge!.target_space_id).toBe(spaceBId);
    expect(edge!.target_source_path).toBe("wiki/organization/bell-labs.md");
    // link_path round-trips the literal [[...|space:...]] form.
    expect(edge!.link_path).toBe(
      "[[Bell Labs|organization|space:space-b]]",
    );
    expect(edge!.link_path.includes("space:")).toBe(true);
  });

  it("does NOT create a placeholder in the peer space when the cross-space target is missing", async () => {
    writeWiki(
      dirA,
      "wiki/concept/dangler.md",
      "label: Dangler\nsubject_type: concept\n",
      "Refers to [[Nonexistent Org|organization|space:space-b]] in passing.",
    );

    const sourceA = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/dangler.md",
    );

    // Give the watcher a moment to (not) create a placeholder anywhere.
    await new Promise((r) => setTimeout(r, 800));

    // No placeholder in space-b at the computed path.
    const peerHit = await getEntityBySourcePath(
      spaceBId,
      "wiki/organization/nonexistent-org.md",
    );
    expect(peerHit).toBeNull();

    // No placeholder in space-a at the computed path either — cross-
    // space misses don't fall back to creating a same-space placeholder.
    const ownSpaceHit = await getEntityBySourcePath(
      spaceAId,
      "wiki/organization/nonexistent-org.md",
    );
    expect(ownSpaceHit).toBeNull();

    // The dangler wiki has no relationship to "Nonexistent Org".
    const wiki = await api(`/entities/${sourceA.id}`);
    const out = (wiki.relationships?.outgoing ?? []) as Array<{ link_text: string }>;
    expect(out.find((r) => r.link_text === "Nonexistent Org")).toBeUndefined();
  });

  it("warns and drops a cross-space wikilink to an unknown space name", async () => {
    writeWiki(
      dirA,
      "wiki/concept/unknown-space.md",
      "label: UnknownSpaceCaller\nsubject_type: concept\n",
      "Bad target [[Bell Labs|organization|space:not-a-real-space]].",
    );

    const sourceA = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/unknown-space.md",
    );
    await new Promise((r) => setTimeout(r, 800));

    const wiki = await api(`/entities/${sourceA.id}`);
    const out = (wiki.relationships?.outgoing ?? []) as Array<{ link_text: string }>;
    expect(out.find((r) => r.link_text === "Bell Labs")).toBeUndefined();

    // No placeholder created anywhere.
    const inA = await getEntityBySourcePath(
      spaceAId,
      "wiki/organization/bell-labs.md",
    );
    expect(inA).toBeNull();
  });

  it("same-space [[wikilink]] still creates a placeholder (regression guard)", async () => {
    writeWiki(
      dirA,
      "wiki/concept/local-thread.md",
      "label: Local Thread\nsubject_type: concept\n",
      "Mentions [[Local Open Question]].",
    );

    const placeholder = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/local-open-question.md",
    );
    expect(placeholder.type).toBe("wiki");
    expect(placeholder.unresolved).toBe(true);
  });

  it("two-segment shorthand [[Label|space:NAME]] resolves with default subject_type", async () => {
    // Pre-seed a peer-space wiki at the default-typed path.
    writeWiki(
      dirB,
      "wiki/concept/quanta.md",
      "label: Quanta\nsubject_type: concept\n",
      "A short concept wiki in space-b.",
    );
    await waitForEntityBySourcePath(spaceBId, "wiki/concept/quanta.md");

    writeWiki(
      dirA,
      "wiki/concept/shorthand-caller.md",
      "label: Shorthand Caller\nsubject_type: concept\n",
      "References [[Quanta|space:space-b]] without an explicit type.",
    );

    const sourceA = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/shorthand-caller.md",
    );

    const deadline = Date.now() + 5000;
    let edge: Awaited<ReturnType<typeof getOutgoingByLinkText>> = null;
    while (Date.now() < deadline) {
      edge = await getOutgoingByLinkText(sourceA.id, "Quanta");
      if (edge) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(edge).not.toBeNull();
    expect(edge!.target_space_id).toBe(spaceBId);
    expect(edge!.target_source_path).toBe("wiki/concept/quanta.md");
    expect(edge!.link_path).toBe("[[Quanta|space:space-b]]");
  });

  it("resolves space: by id (the disambiguation fallback the warning promises)", async () => {
    writeWiki(
      dirA,
      "wiki/concept/by-id-caller.md",
      "label: By-ID Caller\nsubject_type: concept\n",
      // The space hint is the literal ULID — the resolver tries id
      // first, then name. Ids are 26-char alnum so they're disjoint
      // from any human space name in practice.
      `References [[Bell Labs|organization|space:${spaceBId}]] across spaces.`,
    );

    const sourceA = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/by-id-caller.md",
    );

    const deadline = Date.now() + 5000;
    let edge: Awaited<ReturnType<typeof getOutgoingByLinkText>> = null;
    while (Date.now() < deadline) {
      edge = await getOutgoingByLinkText(sourceA.id, "Bell Labs");
      if (edge) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(edge).not.toBeNull();
    expect(edge!.target_space_id).toBe(spaceBId);
    expect(edge!.link_path).toBe(
      `[[Bell Labs|organization|space:${spaceBId}]]`,
    );
  });

  // ── ambiguity ───────────────────────────────────────────────────
  // This test taints the registry — it registers a second space with
  // name 'space-b'. Keep it last in the file so subsequent tests
  // wouldn't be affected (vitest runs tests in file order).
  it("warns and drops a cross-space wikilink whose name is ambiguous; id still resolves", async () => {
    // Register a second space sharing 'space-b' as its name. Different
    // watch_dir, so the schema's UNIQUE(watch_dir) doesn't reject.
    const resDup = await fetch(`${BASE_URL}/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "space-b", watch_dir: dirDup }),
    });
    spaceDupId = ((await resDup.json()) as { id: string }).id;
    expect(spaceDupId).not.toBe(spaceBId);

    // Name-based: ambiguous → warn-and-drop. No relationship.
    writeWiki(
      dirA,
      "wiki/concept/ambiguous-caller.md",
      "label: Ambiguous Caller\nsubject_type: concept\n",
      "Tries [[Bell Labs|organization|space:space-b]] under an ambiguous name.",
    );
    const sourceA = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/ambiguous-caller.md",
    );
    await new Promise((r) => setTimeout(r, 800));

    const wiki = await api(`/entities/${sourceA.id}`);
    const out = (wiki.relationships?.outgoing ?? []) as Array<{ link_text: string }>;
    expect(out.find((r) => r.link_text === "Bell Labs")).toBeUndefined();

    // Id-based: still resolves to the original space-b. The
    // disambiguation message in the warn-and-drop above promises this
    // works; this assertion is what makes the promise testable.
    writeWiki(
      dirA,
      "wiki/concept/disambiguated-caller.md",
      "label: Disambiguated Caller\nsubject_type: concept\n",
      `Falls back to id [[Bell Labs|organization|space:${spaceBId}]].`,
    );
    const sourceB = await waitForEntityBySourcePath(
      spaceAId,
      "wiki/concept/disambiguated-caller.md",
    );
    const deadline = Date.now() + 5000;
    let edge: Awaited<ReturnType<typeof getOutgoingByLinkText>> = null;
    while (Date.now() < deadline) {
      edge = await getOutgoingByLinkText(sourceB.id, "Bell Labs");
      if (edge) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(edge).not.toBeNull();
    expect(edge!.target_space_id).toBe(spaceBId);
  });
});
