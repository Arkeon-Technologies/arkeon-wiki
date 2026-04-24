// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the filesystem-first sync engine.
 *
 * These tests start a SQLite database + API server, register a temp
 * directory as a space, and exercise the full lifecycle: file creation,
 * modification, deletion, link resolution, and watcher-based auto-sync.
 *
 * Run: npm run test:e2e -w packages/arkeon
 * Requires: no running arkeon instance (uses its own ports)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Port that won't collide with other services
const API_PORT = 18787;
const BASE_URL = `http://localhost:${API_PORT}`;

// Temp dirs — created fresh per test suite
let testDir: string;
let stateDir: string;
let serverHandle: { stop: () => Promise<void> } | null = null;

// ── Helpers ──────────────────────────────────────────────────────────

function writeWiki(
  relativePath: string,
  properties: Record<string, unknown>,
  body: string,
): void {
  const absPath = join(testDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(properties, null, 2);
  writeFileSync(absPath, `---\n${json}\n---\n\n${body}\n`);
}

function writeSourceFile(relativePath: string, content: string): void {
  const absPath = join(testDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content);
}

function deleteFile(relativePath: string): void {
  const absPath = join(testDir, relativePath);
  if (existsSync(absPath)) unlinkSync(absPath);
}

function readFile(relativePath: string): string {
  return readFileSync(join(testDir, relativePath), "utf-8");
}

async function api(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (res.headers.get("content-type")?.includes("json")) {
    return res.json();
  }
  return res.text();
}

async function getEntities(spaceId?: string): Promise<any[]> {
  const qs = spaceId ? `?space_id=${spaceId}` : "";
  const data = await api(`/entities${qs}`);
  return data.entities ?? [];
}

async function getEntity(id: string): Promise<any> {
  return api(`/entities/${id}`);
}

/** Wait for the watcher to process. Polls until entity count matches or timeout. */
async function waitForEntityCount(expected: number, spaceId: string, timeoutMs = 5000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entities = await getEntities(spaceId);
    if (entities.length === expected) return entities;
    await new Promise((r) => setTimeout(r, 300));
  }
  // Return whatever we have — the assertion will fail with a useful message
  return getEntities(spaceId);
}

/** Wait for an entity's properties to match a predicate. */
async function waitForEntity(
  id: string,
  predicate: (entity: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entity = await getEntity(id);
      if (entity && !entity.error && predicate(entity)) return entity;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return getEntity(id);
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeAll(async () => {
  // Create isolated temp directories
  const base = join(tmpdir(), `arkeon-test-${randomBytes(4).toString("hex")}`);
  testDir = join(base, "repo");
  stateDir = join(base, "state");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(join(testDir, "wiki"), { recursive: true });

  // Set env for state directory
  process.env.ARKEON_WIKI_HOME = stateDir;

  const dbFile = join(stateDir, "data", "arke.db");

  // Run migrations
  const { runMigrations } = await import("../../src/schema/index.js");
  await runMigrations({ dbPath: dbFile });

  // Start the API server
  const { startApi } = await import("../../src/server/server.js");
  const apiHandle = await startApi({ port: API_PORT, dbPath: dbFile });

  serverHandle = {
    stop: async () => {
      await apiHandle.stop();
    },
  };
}, 30_000);

afterAll(async () => {
  if (serverHandle) {
    await serverHandle.stop();
  }
  // Clean up temp dirs
  if (testDir && existsSync(testDir)) {
    rmSync(testDir.substring(0, testDir.lastIndexOf("/")), { recursive: true, force: true });
  }
}, 30_000);

// ── Tests ────────────────────────────────────────────────────────────

describe("health", () => {
  it("reports healthy", async () => {
    const data = await api("/health");
    expect(data.status).toBe("ok");
  });

  it("reports ready", async () => {
    const data = await api("/ready");
    expect(data.status).toBe("ready");
  });
});

describe("space registration + auto-sync", () => {
  let spaceId: string;

  it("creates a space and starts watching", async () => {
    // Put a file in the directory BEFORE registering the space
    writeWiki("wiki/person/pre-existing.md", {
      label: "Pre-Existing Entity",
      subject_type: "person",
    }, "This entity existed before init.");

    // Register the space
    const data = await api("/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-space", watch_dir: testDir }),
    });

    expect(data.id).toBeTruthy();
    spaceId = data.id;

    // Wait for reconciliation to pick up the pre-existing file
    const entities = await waitForEntityCount(1, spaceId);
    expect(entities).toHaveLength(1);
    expect(entities[0].label).toBe("Pre-Existing Entity");
  });

  it("auto-detects new wiki files", async () => {
    writeWiki("wiki/person/alan-turing.md", {
      label: "Alan Turing",
      subject_type: "person",
      birth_year: 1912,
    }, "Alan Turing was a mathematician.");

    const entities = await waitForEntityCount(2, spaceId);
    const turing = entities.find((e: any) => e.label === "Alan Turing");
    expect(turing).toBeTruthy();
    expect(turing.type).toBe("wiki");
    expect(turing.source_path).toBe("wiki/person/alan-turing.md");
  });

  it("writes generated ID back to frontmatter", async () => {
    // The entity should have gotten an ID written back
    const entities = await getEntities(spaceId);
    const turing = entities.find((e: any) => e.label === "Alan Turing");
    expect(turing).toBeTruthy();

    // Read the file and check frontmatter has the ID
    const content = readFile("wiki/person/alan-turing.md");
    expect(content).toContain(`"id": "${turing.id}"`);
  });

  it("auto-detects file modifications", async () => {
    const entities = await getEntities(spaceId);
    const turing = entities.find((e: any) => e.label === "Alan Turing");

    // Rewrite with updated properties
    writeWiki("wiki/person/alan-turing.md", {
      id: turing.id,
      label: "Alan Turing",
      subject_type: "person",
      birth_year: 1912,
      nationality: "British",
    }, "Alan Turing was a British mathematician.");

    // Wait for the update
    const updated = await waitForEntity(
      turing.id,
      (e) => {
        const props = typeof e.properties === "string" ? JSON.parse(e.properties) : e.properties;
        return props.nationality === "British";
      },
    );

    const props = typeof updated.properties === "string" ? JSON.parse(updated.properties) : updated.properties;
    expect(props.nationality).toBe("British");
  });

  it("auto-detects file deletions", async () => {
    deleteFile("wiki/person/pre-existing.md");

    const entities = await waitForEntityCount(1, spaceId);
    expect(entities).toHaveLength(1);
    expect(entities[0].label).toBe("Alan Turing");
  });

  it("resolves markdown links between wiki files", async () => {
    const entities = await getEntities(spaceId);
    const turing = entities.find((e: any) => e.label === "Alan Turing");

    // Create a wiki that links to Turing
    writeWiki("wiki/concept/computability.md", {
      label: "Computability",
      subject_type: "concept",
    }, `Computability theory was advanced by [Alan Turing](../person/alan-turing.md).`);

    const updated = await waitForEntityCount(2, spaceId);
    const computability = updated.find((e: any) => e.label === "Computability");
    expect(computability).toBeTruthy();

    // Check the relationship
    const entity = await getEntity(computability.id);
    expect(entity.relationships.outgoing).toHaveLength(1);
    expect(entity.relationships.outgoing[0].target_id).toBe(turing.id);
    expect(entity.relationships.outgoing[0].link_text).toBe("Alan Turing");
    expect(entity.relationships.outgoing[0].predicate).toBe("references");
  });

  it("resolves incoming relationships", async () => {
    const entities = await getEntities(spaceId);
    const turing = entities.find((e: any) => e.label === "Alan Turing");

    const entity = await getEntity(turing.id);
    expect(entity.relationships.incoming).toHaveLength(1);
    expect(entity.relationships.incoming[0].source_label).toBe("Computability");
  });

  it("handles dangling links gracefully", async () => {
    writeWiki("wiki/person/shannon.md", {
      label: "Claude Shannon",
      subject_type: "person",
    }, "Shannon worked at [Bell Labs](../organization/bell-labs.md).");

    const entities = await waitForEntityCount(3, spaceId);
    const shannon = entities.find((e: any) => e.label === "Claude Shannon");

    const entity = await getEntity(shannon.id);
    // Link target doesn't exist — should have no outgoing relationships
    expect(entity.relationships.outgoing).toHaveLength(0);
  });

  it("resolves previously dangling links when target is created", async () => {
    const entitiesBefore = await getEntities(spaceId);
    const shannon = entitiesBefore.find((e: any) => e.label === "Claude Shannon");

    // Create the target that was dangling
    writeWiki("wiki/organization/bell-labs.md", {
      label: "Bell Labs",
      subject_type: "organization",
    }, "Bell Labs was a research lab.");

    await waitForEntityCount(4, spaceId);

    // Re-sync Shannon to resolve the previously dangling link
    // (modify the file slightly to trigger a re-sync)
    writeWiki("wiki/person/shannon.md", {
      id: shannon.id,
      label: "Claude Shannon",
      subject_type: "person",
      birth_year: 1916,
    }, "Shannon worked at [Bell Labs](../organization/bell-labs.md).");

    const updated = await waitForEntity(
      shannon.id,
      (e) => e.relationships?.outgoing?.length > 0,
    );

    expect(updated.relationships.outgoing).toHaveLength(1);
    expect(updated.relationships.outgoing[0].target_label).toBe("Bell Labs");
  });

  it("indexes source (non-wiki) files", async () => {
    writeSourceFile("notes/meeting.txt", "Meeting notes from today.");

    const entities = await waitForEntityCount(5, spaceId);
    const meeting = entities.find((e: any) => e.label === "meeting");
    expect(meeting).toBeTruthy();
    expect(meeting.type).toBe("file");
    expect(meeting.source_path).toBe("notes/meeting.txt");
  });

  it("handles deeply nested directory structures", async () => {
    writeWiki("wiki/science/physics/quantum/entanglement.md", {
      label: "Quantum Entanglement",
      subject_type: "concept",
    }, "A phenomenon in quantum mechanics.");

    const entities = await waitForEntityCount(6, spaceId);
    const qe = entities.find((e: any) => e.label === "Quantum Entanglement");
    expect(qe).toBeTruthy();
    expect(qe.source_path).toBe("wiki/science/physics/quantum/entanglement.md");
  });

  it("ignores dotfiles and excluded directories", async () => {
    // These should NOT be indexed
    writeSourceFile(".hidden-file.md", "hidden");
    mkdirSync(join(testDir, ".git", "objects"), { recursive: true });
    writeSourceFile(".git/objects/test.md", "git internal");
    mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
    writeSourceFile("node_modules/pkg/README.md", "npm package");

    // Give the watcher time to (not) pick these up
    await new Promise((r) => setTimeout(r, 1500));

    const entities = await getEntities(spaceId);
    const paths = entities.map((e: any) => e.source_path);
    expect(paths).not.toContain(".hidden-file.md");
    expect(paths).not.toContain(".git/objects/test.md");
    expect(paths).not.toContain("node_modules/pkg/README.md");
  });

  it("handles rapid successive edits (debounce)", async () => {
    const entities = await getEntities(spaceId);
    const turing = entities.find((e: any) => e.label === "Alan Turing");

    // Rapid-fire edits
    for (let i = 0; i < 5; i++) {
      writeWiki("wiki/person/alan-turing.md", {
        id: turing.id,
        label: "Alan Turing",
        subject_type: "person",
        birth_year: 1912,
        nationality: "British",
        edit_count: i + 1,
      }, `Alan Turing was a British mathematician. Edit ${i + 1}.`);
    }

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 2000));

    // Should have the final version
    const updated = await getEntity(turing.id);
    const props = typeof updated.properties === "string" ? JSON.parse(updated.properties) : updated.properties;
    expect(props.edit_count).toBe(5);
  });

  it("handles complex JSON properties", async () => {
    writeWiki("wiki/concept/complex-props.md", {
      label: "Complex Properties Test",
      subject_type: "concept",
      tags: ["math", "science", "history"],
      citations: [
        { author: "Smith", year: 2020, title: "A Paper" },
        { author: "Jones", year: 2021, title: "Another Paper" },
      ],
      metadata: {
        confidence: 0.95,
        verified: true,
        nested: { deep: { value: "found" } },
      },
    }, "Testing complex property storage.");

    const entities = await waitForEntityCount(7, spaceId);
    const complex = entities.find((e: any) => e.label === "Complex Properties Test");
    const props = typeof complex.properties === "string" ? JSON.parse(complex.properties) : complex.properties;

    expect(props.tags).toEqual(["math", "science", "history"]);
    expect(props.citations).toHaveLength(2);
    expect(props.citations[0].author).toBe("Smith");
    expect(props.metadata.nested.deep.value).toBe("found");
  });

  it("handles wiki with multiple outgoing links", async () => {
    const entities = await getEntities(spaceId);
    const turing = entities.find((e: any) => e.label === "Alan Turing");
    const computability = entities.find((e: any) => e.label === "Computability");

    writeWiki("wiki/concept/cs-history.md", {
      label: "CS History",
      subject_type: "concept",
    }, `Computer science history involves [Alan Turing](../person/alan-turing.md) and [Computability](computability.md).`);

    const updated = await waitForEntityCount(8, spaceId);
    const csHistory = updated.find((e: any) => e.label === "CS History");
    const entity = await getEntity(csHistory.id);

    expect(entity.relationships.outgoing).toHaveLength(2);
    const targetIds = entity.relationships.outgoing.map((r: any) => r.target_id).sort();
    expect(targetIds).toContain(turing.id);
    expect(targetIds).toContain(computability.id);
  });
});

describe("API read endpoints", () => {
  it("lists entities with filtering", async () => {
    const all = await api("/entities");
    expect(all.total).toBeGreaterThan(0);

    // Filter by type
    const wikis = await api("/entities?type=wiki");
    const files = await api("/entities?type=file");
    expect(wikis.entities.every((e: any) => e.type === "wiki")).toBe(true);
    expect(files.entities.every((e: any) => e.type === "file")).toBe(true);
    expect(wikis.total + files.total).toBe(all.total);
  });

  it("supports pagination", async () => {
    const page1 = await api("/entities?limit=2&offset=0");
    const page2 = await api("/entities?limit=2&offset=2");

    expect(page1.entities).toHaveLength(2);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);

    // Different entities on each page
    const ids1 = page1.entities.map((e: any) => e.id);
    const ids2 = page2.entities.map((e: any) => e.id);
    for (const id of ids1) {
      expect(ids2).not.toContain(id);
    }
  });

  it("returns 404 for nonexistent entity", async () => {
    const data = await api("/entities/nonexistent");
    expect(data.error?.code).toBe("not_found");
  });

  it("lists spaces with entity counts", async () => {
    const data = await api("/spaces");
    expect(data.spaces).toHaveLength(1);
    expect(data.spaces[0].name).toBe("test-space");
    expect(data.spaces[0].entity_count).toBeGreaterThan(0);
  });

  it("gets a single space", async () => {
    const all = await api("/spaces");
    const spaceId = all.spaces[0].id;
    const space = await api(`/spaces/${spaceId}`);
    expect(space.name).toBe("test-space");
    expect(space.watch_dir).toBe(testDir);
  });
});

describe("include=relationships on list endpoint", () => {
  it("returns relationships alongside entities", async () => {
    const data = await api("/entities?include=relationships");
    expect(data.entities.length).toBeGreaterThan(0);
    expect(data.relationships).toBeDefined();
    expect(Array.isArray(data.relationships)).toBe(true);

    // Should have relationship edges (we created linked wikis earlier)
    expect(data.relationships.length).toBeGreaterThan(0);

    // Each relationship should have the expected shape
    const rel = data.relationships[0];
    expect(rel.source_id).toBeTruthy();
    expect(rel.target_id).toBeTruthy();
    expect(rel.predicate).toBeTruthy();
  });

  it("does not return relationships without the flag", async () => {
    const data = await api("/entities");
    expect(data.relationships).toBeUndefined();
  });

  it("scopes relationships to the space filter", async () => {
    const spaces = await api("/spaces");
    const spaceId = spaces.spaces[0].id;
    const data = await api(`/entities?space_id=${spaceId}&include=relationships`);

    expect(data.entities.length).toBeGreaterThan(0);
    expect(data.relationships).toBeDefined();

    // All entities should be in the requested space
    for (const e of data.entities) {
      expect(e.space_id).toBe(spaceId);
    }
  });
});

describe("include=content on detail endpoint", () => {
  it("returns file content when requested", async () => {
    const entities = await getEntities();
    const wiki = entities.find((e: any) => e.type === "wiki" && e.label === "Alan Turing");
    expect(wiki).toBeTruthy();

    const withContent = await api(`/entities/${wiki.id}?include=content`);
    expect(withContent.content).toBeTruthy();
    expect(typeof withContent.content).toBe("string");
    // Content should contain the frontmatter and body
    expect(withContent.content).toContain("Alan Turing");
    expect(withContent.content).toContain("---");
  });

  it("does not return content without the flag", async () => {
    const entities = await getEntities();
    const wiki = entities.find((e: any) => e.type === "wiki");

    const withoutContent = await api(`/entities/${wiki.id}`);
    expect(withoutContent.content).toBeUndefined();
  });

  it("returns null content for missing files", async () => {
    // Create an entity, then delete its file but keep the entity
    const entities = await getEntities();
    const wiki = entities.find((e: any) => e.type === "wiki" && e.label === "Quantum Entanglement");
    expect(wiki).toBeTruthy();

    // Delete the file manually (without going through the watcher)
    const absPath = join(testDir, wiki.source_path);
    if (existsSync(absPath)) unlinkSync(absPath);

    const result = await api(`/entities/${wiki.id}?include=content`);
    expect(result.content).toBeNull();
  });
});

describe("entity deletion via API", () => {
  it("deletes an entity", async () => {
    const entities = await getEntities();
    const toDelete = entities.find((e: any) => e.label === "meeting");
    expect(toDelete).toBeTruthy();

    const result = await api(`/entities/${toDelete.id}`, { method: "DELETE" });
    expect(result.deleted).toBe(true);

    const after = await api(`/entities/${toDelete.id}`);
    expect(after.error?.code).toBe("not_found");
  });
});

describe("schema idempotency", () => {
  it("runs migrations twice without error", async () => {
    const { runMigrations } = await import("../../src/schema/index.js");
    const dbFile = join(stateDir, "data", "arke.db");
    // Should not throw — all statements use IF NOT EXISTS
    await runMigrations({ dbPath: dbFile });
  });
});
