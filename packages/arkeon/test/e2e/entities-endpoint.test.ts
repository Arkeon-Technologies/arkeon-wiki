// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the generic GET /entities listing.
 *
 * One space is set up with a representative mix:
 *   - a wiki with one outbound [[wikilink]] (creates a stub)
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

  // Seed the corpus.
  writeWiki(
    "wiki/concept/leaf.md",
    { label: "Leaf Concept", subject_type: "concept" },
    "An isolated wiki with no links in or out.",
  );
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

  // Wait for everything to land.
  await waitForEntityBySourcePath(spaceId, "wiki/concept/leaf.md");
  await waitForEntityBySourcePath(spaceId, "wiki/concept/hub.md");
  await waitForEntityBySourcePath(spaceId, "wiki/person/seeker.md");
  await waitForEntityBySourcePath(spaceId, "sources/raw-input.txt");
  await waitForEntityBySourcePath(spaceId, "wiki/concept/unknown-topic.md");
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
    expect(types.has("stub")).toBe(true);
    expect(data.total).toBe(5); // 3 wikis + 1 file + 1 stub
  });

  it("filters by single type", async () => {
    const stubs = await api(`?space_id=${spaceId}&type=stub`);
    expect(stubs.entities).toHaveLength(1);
    expect(stubs.entities[0].label).toBe("Unknown Topic");
    expect(stubs.entities[0].type).toBe("stub");
  });

  it("filters by multiple types via comma list", async () => {
    const data = await api(`?space_id=${spaceId}&type=wiki,stub`);
    const types = new Set(data.entities.map((e: any) => e.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("stub")).toBe(true);
    expect(types.has("file")).toBe(false);
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
    // Leaf is linked from Hub; Unknown Topic stub is linked from Seeker.
    expect(labels).toEqual(["Leaf Concept", "Unknown Topic"]);
    const leaf = linked.entities.find((e: any) => e.label === "Leaf Concept");
    expect(leaf.counts.inbound).toBe(1);
  });

  it("filters by inbound count: inbound_max=0 finds the orphans", async () => {
    const orphans = await api(`?space_id=${spaceId}&inbound_max=0&type=wiki`);
    const labels = orphans.entities.map((e: any) => e.label).sort();
    expect(labels).toEqual(["Hub Concept", "Seeker"]);
  });

  it("has_unresolved_outbound=true surfaces wikis pointing at stubs", async () => {
    const data = await api(
      `?space_id=${spaceId}&has_unresolved_outbound=true`,
    );
    expect(data.entities).toHaveLength(1);
    expect(data.entities[0].label).toBe("Seeker");
    expect(data.entities[0].has_unresolved_outbound).toBe(true);
  });

  it("has_unresolved_outbound=false hides them", async () => {
    const data = await api(
      `?space_id=${spaceId}&has_unresolved_outbound=false&type=wiki`,
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
    // Hub→Leaf and Seeker→stub both have wiki sources.
    expect(data.relationships.length).toBeGreaterThanOrEqual(2);
  });

  it("edited_by_role=human matches filesystem-driven edits", async () => {
    // syncFile attributes filesystem-driven creations to "human" with
    // edit_kind="resync" (sync.ts:120). Every wiki we wrote here was
    // a plain disk write, so they all qualify. Stubs aren't recorded
    // in entity_edits because their creation doesn't go through the
    // edit-context-tagged write path.
    const data = await api(`?space_id=${spaceId}&edited_by_role=human`);
    const types = new Set(data.entities.map((e: any) => e.type));
    expect(types.has("wiki")).toBe(true);
    expect(types.has("file")).toBe(true);
    expect(types.has("stub")).toBe(false);
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
