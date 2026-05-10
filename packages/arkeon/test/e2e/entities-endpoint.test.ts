// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the generic GET /entities listing.
 *
 * One space is set up with a representative mix:
 *   - a wiki with one outbound [[wikilink]] (creates a placeholder)
 *   - a separate wiki with two outbound standard links to existing wikis
 *   - one isolated wiki with no links in or out
 *   - one source file
 *
 * The tests then exercise filters/sorts/includes against that fixture.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";
import { waitForEntityBySourcePath } from "./helpers.js";

const API_PORT = 18794;
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

function writeSource(relativePath: string, content: string): void {
  const absPath = join(testDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content);
}

async function api(qs: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/entities${qs}`);
  return res.json();
}

beforeAll(async () => {
  const base = join(tmpdir(), `arkeon-entities-${randomBytes(4).toString("hex")}`);
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

  const spaceData = await fetch(`${BASE_URL}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "entities-test", watch_dir: testDir }),
  }).then((r) => r.json());
  spaceId = spaceData.id;

  // Seed the corpus. Write leaf first and wait for it to land so the
  // hub→leaf standard markdown link resolves on hub's first sync (rather
  // than getting warned-and-dropped if the watcher happens to process
  // hub before leaf).
  writeWiki(
    "wiki/concept/leaf.md",
    { label: "Leaf Concept", subject_type: "concept" },
    "An isolated wiki with no links in or out.",
  );
  await waitForEntityBySourcePath(spaceId, "wiki/concept/leaf.md");

  writeWiki(
    "wiki/concept/hub.md",
    { label: "Hub Concept", subject_type: "concept" },
    "Pulls in [Leaf Concept](leaf.md) for reference.",
  );
  writeWiki(
    "wiki/person/seeker.md",
    { label: "Seeker", subject_type: "person" },
    "Wants to explore [[Unknown Topic]] further.",
  );
  writeSource("sources/raw-input.txt", "Some plain text source content.");

  await waitForEntityBySourcePath(spaceId, "wiki/concept/hub.md");
  await waitForEntityBySourcePath(spaceId, "wiki/person/seeker.md");
  await waitForEntityBySourcePath(spaceId, "sources/raw-input.txt");
  await waitForEntityBySourcePath(spaceId, "wiki/concept/unknown-topic.md");

  // Wait for the hub→leaf relationship to be in place — without it, the
  // inbound-count tests are flaky on slow runners.
  const relDeadline = Date.now() + 5000;
  while (Date.now() < relDeadline) {
    const data = await fetch(
      `${BASE_URL}/entities?space_id=${spaceId}&type=wiki&inbound_min=1`,
    ).then((r) => r.json());
    if (data.entities?.some((e: { label: string }) => e.label === "Leaf Concept")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
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

describe("GET /entities", () => {
  it("returns all entity types when no filter is given", async () => {
    const data = await api(`?space_id=${spaceId}&limit=100`);
    const types = new Set(data.entities.map((e: any) => e.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
    // The placeholder for "Unknown Topic" is a wiki, not a separate type.
    const unresolved = data.entities.filter((e: any) => e.unresolved);
    expect(unresolved.map((e: any) => e.label).sort()).toEqual(["Unknown Topic"]);
    expect(data.total).toBe(5); // 3 wikis + 1 file + 1 placeholder wiki
  });

  it("filters by single type", async () => {
    const wikis = await api(`?space_id=${spaceId}&type=wiki`);
    // 3 realized + 1 placeholder = 4 wikis total.
    expect(wikis.entities).toHaveLength(4);
    for (const e of wikis.entities) expect(e.type).toBe("wiki");
  });

  it("filters by multiple types via comma list", async () => {
    const data = await api(`?space_id=${spaceId}&type=wiki,file`);
    const types = new Set(data.entities.map((e: any) => e.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
    expect(data.entities.length).toBe(5);
  });

  it("unresolved=true surfaces placeholder wikis", async () => {
    const data = await api(`?space_id=${spaceId}&unresolved=true`);
    expect(data.entities).toHaveLength(1);
    expect(data.entities[0].label).toBe("Unknown Topic");
    expect(data.entities[0].type).toBe("wiki");
    expect(data.entities[0].unresolved).toBe(true);
  });

  it("unresolved=false hides placeholders", async () => {
    const data = await api(`?space_id=${spaceId}&unresolved=false&type=wiki`);
    const labels = data.entities.map((e: any) => e.label).sort();
    expect(labels).toEqual(["Hub Concept", "Leaf Concept", "Seeker"]);
    for (const e of data.entities) expect(e.unresolved).toBe(false);
  });

  it("rejects ?type=stub with a 400 pointing at the new filter", async () => {
    const res = await fetch(`${BASE_URL}/entities?space_id=${spaceId}&type=stub`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error?.message ?? body.message ?? "")).toMatch(/unresolved/);
  });

  it("filters by subject_type from frontmatter", async () => {
    const persons = await api(
      `?space_id=${spaceId}&subject_type=person&type=wiki`,
    );
    expect(persons.entities).toHaveLength(1);
    expect(persons.entities[0].label).toBe("Seeker");
  });

  it("filters by inbound count: inbound_min=1 finds only the linked-to wiki", async () => {
    const linked = await api(
      `?space_id=${spaceId}&inbound_min=1&include=counts`,
    );
    const labels = linked.entities.map((e: any) => e.label).sort();
    // Leaf is linked from Hub; Unknown Topic placeholder is linked from Seeker.
    expect(labels).toEqual(["Leaf Concept", "Unknown Topic"]);
    const leaf = linked.entities.find((e: any) => e.label === "Leaf Concept");
    expect(leaf.counts.inbound).toBe(1);
  });

  it("filters by inbound count: inbound_max=0 finds the orphans", async () => {
    const orphans = await api(`?space_id=${spaceId}&inbound_max=0&type=wiki`);
    const labels = orphans.entities.map((e: any) => e.label).sort();
    expect(labels).toEqual(["Hub Concept", "Seeker"]);
  });

  it("has_unresolved_outbound=true surfaces wikis pointing at placeholders", async () => {
    const data = await api(
      `?space_id=${spaceId}&has_unresolved_outbound=true`,
    );
    expect(data.entities).toHaveLength(1);
    expect(data.entities[0].label).toBe("Seeker");
    expect(data.entities[0].has_unresolved_outbound).toBe(true);
  });

  it("has_unresolved_outbound=false hides them", async () => {
    // Filter to realized wikis (unresolved=false) so the Unknown Topic
    // placeholder — which has no outbound but is itself unresolved —
    // doesn't show up.
    const data = await api(
      `?space_id=${spaceId}&has_unresolved_outbound=false&type=wiki&unresolved=false`,
    );
    const labels = data.entities.map((e: any) => e.label).sort();
    expect(labels).toEqual(["Hub Concept", "Leaf Concept"]);
  });

  it("sort=inbound puts the most-linked-to entity first", async () => {
    const data = await api(
      `?space_id=${spaceId}&sort=inbound&include=counts`,
    );
    expect(data.entities[0].counts.inbound).toBeGreaterThanOrEqual(
      data.entities[data.entities.length - 1].counts.inbound,
    );
  });

  it("sort=label gives case-insensitive A-Z", async () => {
    const data = await api(`?space_id=${spaceId}&sort=label&type=wiki`);
    const labels = data.entities.map((e: any) => e.label);
    expect(labels).toEqual([...labels].sort((a: string, b: string) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ));
  });

  it("include=counts attaches inbound and outbound", async () => {
    const data = await api(`?space_id=${spaceId}&include=counts&type=wiki`);
    for (const e of data.entities) {
      expect(e.counts).toBeDefined();
      expect(typeof e.counts.inbound).toBe("number");
      expect(typeof e.counts.outbound).toBe("number");
    }
  });

  it("omitting include=counts leaves counts off the row", async () => {
    const data = await api(`?space_id=${spaceId}&type=wiki`);
    for (const e of data.entities) {
      expect(e.counts).toBeUndefined();
    }
  });

  it("include=relationships attaches a top-level relationships array", async () => {
    const data = await api(
      `?space_id=${spaceId}&type=wiki&include=relationships`,
    );
    expect(Array.isArray(data.relationships)).toBe(true);
    // Hub→Leaf and Seeker→placeholder both have wiki sources.
    expect(data.relationships.length).toBeGreaterThanOrEqual(2);
  });

  it("edited_by_role=human matches filesystem-driven edits", async () => {
    // syncFile attributes filesystem-driven creations to "human" with
    // edit_kind="resync" (sync.ts:120). Every wiki we wrote here was a
    // plain disk write, so they all qualify. Placeholders aren't recorded
    // in entity_edits because their creation doesn't go through the
    // edit-context-tagged write path — and unresolved=false confirms the
    // attributed entities are all realized.
    const data = await api(`?space_id=${spaceId}&edited_by_role=human`);
    const types = new Set(data.entities.map((e: any) => e.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
    for (const e of data.entities) expect(e.unresolved).toBe(false);
  });

  it("rejects an invalid sort value with 400", async () => {
    const res = await fetch(`${BASE_URL}/entities?space_id=${spaceId}&sort=garbage`);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown type with 400", async () => {
    const res = await fetch(`${BASE_URL}/entities?space_id=${spaceId}&type=monster`);
    expect(res.status).toBe(400);
  });
});
