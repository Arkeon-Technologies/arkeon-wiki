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
import yaml from "js-yaml";
import {
  getEntityBySourcePath,
  waitForEntityBySourcePath,
} from "./helpers.js";

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
  const fm = yaml.dump(properties, { schema: yaml.JSON_SCHEMA, sortKeys: false }).trimEnd();
  writeFileSync(absPath, `---\n${fm}\n---\n\n${body}\n`);
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

async function getWikis(spaceId?: string): Promise<any[]> {
  const qs = spaceId ? `?space_id=${spaceId}` : "";
  const data = await api(`/wikis${qs}`);
  return data.wikis ?? [];
}

async function getWiki(id: string): Promise<any> {
  return api(`/wikis/${id}`);
}

/** Wait for the wiki count for a space to reach `expected`. Returns the wiki list. */
async function waitForWikiCount(expected: number, spaceId: string, timeoutMs = 5000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wikis = await getWikis(spaceId);
    if (wikis.length === expected) return wikis;
    await new Promise((r) => setTimeout(r, 300));
  }
  return getWikis(spaceId);
}

/** Wait for a wiki's response to match a predicate. */
async function waitForWiki(
  id: string,
  predicate: (wiki: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const wiki = await getWiki(id);
      if (wiki && !wiki.error && predicate(wiki)) return wiki;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return getWiki(id);
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
    const wikis = await waitForWikiCount(1, spaceId);
    expect(wikis).toHaveLength(1);
    expect(wikis[0].label).toBe("Pre-Existing Entity");
  });

  it("auto-detects new wiki files", async () => {
    writeWiki("wiki/person/alan-turing.md", {
      label: "Alan Turing",
      subject_type: "person",
      birth_year: 1912,
    }, "Alan Turing was a mathematician.");

    const wikis = await waitForWikiCount(2, spaceId);
    const turing = wikis.find((e: any) => e.label === "Alan Turing");
    expect(turing).toBeTruthy();
    expect(turing.source_path).toBe("wiki/person/alan-turing.md");
  });

  it("writes generated ID back to frontmatter", async () => {
    const wikis = await getWikis(spaceId);
    const turing = wikis.find((e: any) => e.label === "Alan Turing");
    expect(turing).toBeTruthy();

    const content = readFile("wiki/person/alan-turing.md");
    expect(content).toContain(`id: ${turing.id}`);
  });

  it("auto-detects file modifications", async () => {
    const wikis = await getWikis(spaceId);
    const turing = wikis.find((e: any) => e.label === "Alan Turing");

    writeWiki("wiki/person/alan-turing.md", {
      id: turing.id,
      label: "Alan Turing",
      subject_type: "person",
      birth_year: 1912,
      nationality: "British",
    }, "Alan Turing was a British mathematician.");

    const updated = await waitForWiki(
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

    const wikis = await waitForWikiCount(1, spaceId);
    expect(wikis).toHaveLength(1);
    expect(wikis[0].label).toBe("Alan Turing");
  });

  it("resolves markdown links between wiki files", async () => {
    const wikis = await getWikis(spaceId);
    const turing = wikis.find((e: any) => e.label === "Alan Turing");

    writeWiki("wiki/concept/computability.md", {
      label: "Computability",
      subject_type: "concept",
    }, `Computability theory was advanced by [Alan Turing](../person/alan-turing.md).`);

    const updated = await waitForWikiCount(2, spaceId);
    const computability = updated.find((e: any) => e.label === "Computability");
    expect(computability).toBeTruthy();

    const wiki = await getWiki(computability.id);
    expect(wiki.relationships.outgoing).toHaveLength(1);
    expect(wiki.relationships.outgoing[0].target_id).toBe(turing.id);
    expect(wiki.relationships.outgoing[0].link_text).toBe("Alan Turing");
    expect(wiki.relationships.outgoing[0].predicate).toBe("references");
  });

  it("resolves incoming relationships", async () => {
    const wikis = await getWikis(spaceId);
    const turing = wikis.find((e: any) => e.label === "Alan Turing");

    const wiki = await getWiki(turing.id);
    expect(wiki.relationships.incoming).toHaveLength(1);
    expect(wiki.relationships.incoming[0].source_label).toBe("Computability");
  });

  it("handles dangling links gracefully", async () => {
    writeWiki("wiki/person/shannon.md", {
      label: "Claude Shannon",
      subject_type: "person",
    }, "Shannon worked at [Bell Labs](../organization/bell-labs.md).");

    const wikis = await waitForWikiCount(3, spaceId);
    const shannon = wikis.find((e: any) => e.label === "Claude Shannon");

    const wiki = await getWiki(shannon.id);
    // Link target doesn't exist — should have no outgoing relationships
    expect(wiki.relationships.outgoing).toHaveLength(0);
  });

  it("resolves previously dangling links when target is created", async () => {
    const wikisBefore = await getWikis(spaceId);
    const shannon = wikisBefore.find((e: any) => e.label === "Claude Shannon");

    writeWiki("wiki/organization/bell-labs.md", {
      label: "Bell Labs",
      subject_type: "organization",
    }, "Bell Labs was a research lab.");

    await waitForWikiCount(4, spaceId);

    // Re-sync Shannon to resolve the previously dangling link
    // (modify the file slightly to trigger a re-sync)
    writeWiki("wiki/person/shannon.md", {
      id: shannon.id,
      label: "Claude Shannon",
      subject_type: "person",
      birth_year: 1916,
    }, "Shannon worked at [Bell Labs](../organization/bell-labs.md).");

    const updated = await waitForWiki(
      shannon.id,
      (e) => e.relationships?.outgoing?.length > 0,
    );

    expect(updated.relationships.outgoing).toHaveLength(1);
    expect(updated.relationships.outgoing[0].target_label).toBe("Bell Labs");
  });

  it("indexes source (non-wiki) files", async () => {
    writeSourceFile("notes/meeting.txt", "Meeting notes from today.");

    // Source files aren't exposed via /wikis — verify via SQLite directly.
    const meeting = await waitForEntityBySourcePath(spaceId, "notes/meeting.txt");
    expect(meeting.type).toBe("file");
    expect(meeting.label).toBe("meeting");
  });

  it("handles deeply nested directory structures", async () => {
    writeWiki("wiki/science/physics/quantum/entanglement.md", {
      label: "Quantum Entanglement",
      subject_type: "concept",
    }, "A phenomenon in quantum mechanics.");

    const wikis = await waitForWikiCount(5, spaceId);
    const qe = wikis.find((e: any) => e.label === "Quantum Entanglement");
    expect(qe).toBeTruthy();
    expect(qe.source_path).toBe("wiki/science/physics/quantum/entanglement.md");
  });

  it("ignores dotfiles and excluded directories", async () => {
    // These should NOT be indexed (any type)
    writeSourceFile(".hidden-file.md", "hidden");
    mkdirSync(join(testDir, ".git", "objects"), { recursive: true });
    writeSourceFile(".git/objects/test.md", "git internal");
    mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
    writeSourceFile("node_modules/pkg/README.md", "npm package");

    // Give the watcher time to (not) pick these up
    await new Promise((r) => setTimeout(r, 1500));

    expect(await getEntityBySourcePath(spaceId, ".hidden-file.md")).toBeNull();
    expect(await getEntityBySourcePath(spaceId, ".git/objects/test.md")).toBeNull();
    expect(await getEntityBySourcePath(spaceId, "node_modules/pkg/README.md")).toBeNull();
  });

  it("handles rapid successive edits (debounce)", async () => {
    const wikis = await getWikis(spaceId);
    const turing = wikis.find((e: any) => e.label === "Alan Turing");

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

    await new Promise((r) => setTimeout(r, 2000));

    const updated = await getWiki(turing.id);
    const props = typeof updated.properties === "string" ? JSON.parse(updated.properties) : updated.properties;
    expect(props.edit_count).toBe(5);
  });

  it("handles complex nested properties", async () => {
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

    const wikis = await waitForWikiCount(6, spaceId);
    const complex = wikis.find((e: any) => e.label === "Complex Properties Test");
    const props = typeof complex.properties === "string" ? JSON.parse(complex.properties) : complex.properties;

    expect(props.tags).toEqual(["math", "science", "history"]);
    expect(props.citations).toHaveLength(2);
    expect(props.citations[0].author).toBe("Smith");
    expect(props.metadata.nested.deep.value).toBe("found");
  });

  it("handles wiki with multiple outgoing links", async () => {
    const wikis = await getWikis(spaceId);
    const turing = wikis.find((e: any) => e.label === "Alan Turing");
    const computability = wikis.find((e: any) => e.label === "Computability");

    writeWiki("wiki/concept/cs-history.md", {
      label: "CS History",
      subject_type: "concept",
    }, `Computer science history involves [Alan Turing](../person/alan-turing.md) and [Computability](computability.md).`);

    const updated = await waitForWikiCount(7, spaceId);
    const csHistory = updated.find((e: any) => e.label === "CS History");
    const wiki = await getWiki(csHistory.id);

    expect(wiki.relationships.outgoing).toHaveLength(2);
    const targetIds = wiki.relationships.outgoing.map((r: any) => r.target_id).sort();
    expect(targetIds).toContain(turing.id);
    expect(targetIds).toContain(computability.id);
  });
});

describe("API read endpoints", () => {
  it("lists wikis", async () => {
    const all = await api("/wikis");
    expect(all.total).toBeGreaterThan(0);
    expect(all.wikis.length).toBeGreaterThan(0);
    // Source files are not in /wikis output
    for (const w of all.wikis) {
      expect(w.type).toBeUndefined();
    }
  });

  it("supports pagination", async () => {
    const page1 = await api("/wikis?limit=2&offset=0");
    const page2 = await api("/wikis?limit=2&offset=2");

    expect(page1.wikis).toHaveLength(2);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);

    const ids1 = page1.wikis.map((e: any) => e.id);
    const ids2 = page2.wikis.map((e: any) => e.id);
    for (const id of ids1) {
      expect(ids2).not.toContain(id);
    }
  });

  it("filters by subject_type", async () => {
    const persons = await api("/wikis?subject_type=person");
    for (const w of persons.wikis) {
      const props = typeof w.properties === "string" ? JSON.parse(w.properties) : w.properties;
      expect(props.subject_type).toBe("person");
    }
  });

  it("filters by label_prefix", async () => {
    const matches = await api("/wikis?label_prefix=Alan");
    expect(matches.wikis.length).toBeGreaterThan(0);
    for (const w of matches.wikis) {
      expect(w.label.toLowerCase().startsWith("alan")).toBe(true);
    }
  });

  it("escapes LIKE wildcards in label_prefix", async () => {
    // Without escaping, `%` would match everything. With escaping, it
    // matches only labels that literally start with `%` — none of ours.
    const data = await api("/wikis?label_prefix=%25"); // URL-encoded `%`
    expect(data.total).toBe(0);
    const data2 = await api("/wikis?label_prefix=_");
    expect(data2.total).toBe(0);
  });

  it("filters by status", async () => {
    // Write a wiki with status:published; wait for the watcher to sync it.
    writeWiki(
      "wiki/concept/published-only.md",
      { label: "Status Filter Probe", subject_type: "concept", status: "published" },
      "Probe for the status filter.",
    );

    const spaces = await api("/spaces");
    const spaceId = spaces.spaces[0].id;

    const deadline = Date.now() + 5000;
    let probe: any;
    while (Date.now() < deadline) {
      const data = await api(`/wikis?space_id=${spaceId}&status=published`);
      probe = data.wikis.find((w: any) => w.label === "Status Filter Probe");
      if (probe) {
        // Every result must have status=published
        for (const w of data.wikis) {
          const props = typeof w.properties === "string" ? JSON.parse(w.properties) : w.properties;
          expect(props.status).toBe("published");
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(probe).toBeTruthy();
  });

  it("supports sort=label", async () => {
    const sorted = await api("/wikis?sort=label");
    const labels = sorted.wikis.map((w: any) => w.label);
    const expected = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(expected);
  });

  it("rejects invalid sort with 400", async () => {
    const data = await api("/wikis?sort=bogus");
    expect(data.error?.code).toBe("validation_error");
  });

  it("combines filters (subject_type + label_prefix)", async () => {
    const data = await api("/wikis?subject_type=person&label_prefix=Alan");
    expect(data.wikis.length).toBeGreaterThan(0);
    for (const w of data.wikis) {
      const props = typeof w.properties === "string" ? JSON.parse(w.properties) : w.properties;
      expect(props.subject_type).toBe("person");
      expect(w.label.toLowerCase().startsWith("alan")).toBe(true);
    }
  });

  it("returns total: 0 for filters that match nothing", async () => {
    const data = await api("/wikis?subject_type=__no_such_type__");
    expect(data.total).toBe(0);
    expect(data.wikis).toHaveLength(0);
  });

  it("returns 404 for nonexistent wiki", async () => {
    const data = await api("/wikis/nonexistent");
    expect(data.error?.code).toBe("not_found");
  });

  it("returns 404 when fetching a source file via /wikis", async () => {
    const meeting = await getEntityBySourcePath(
      (await api("/spaces")).spaces[0].id,
      "notes/meeting.txt",
    );
    expect(meeting).toBeTruthy();
    const data = await api(`/wikis/${meeting!.id}`);
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
  it("returns relationships alongside wikis", async () => {
    const data = await api("/wikis?include=relationships");
    expect(data.wikis.length).toBeGreaterThan(0);
    expect(data.relationships).toBeDefined();
    expect(Array.isArray(data.relationships)).toBe(true);

    expect(data.relationships.length).toBeGreaterThan(0);

    const rel = data.relationships[0];
    expect(rel.source_id).toBeTruthy();
    expect(rel.target_id).toBeTruthy();
    expect(rel.predicate).toBeTruthy();
  });

  it("does not return relationships without the flag", async () => {
    const data = await api("/wikis");
    expect(data.relationships).toBeUndefined();
  });

  it("scopes relationships to the space filter", async () => {
    const spaces = await api("/spaces");
    const spaceId = spaces.spaces[0].id;
    const data = await api(`/wikis?space_id=${spaceId}&include=relationships`);

    expect(data.wikis.length).toBeGreaterThan(0);
    expect(data.relationships).toBeDefined();

    for (const w of data.wikis) {
      expect(w.space_id).toBe(spaceId);
    }
  });
});

describe("include=counts on list endpoint", () => {
  it("attaches per-wiki counts when requested", async () => {
    const data = await api("/wikis?include=counts");
    expect(data.wikis.length).toBeGreaterThan(0);

    for (const w of data.wikis) {
      expect(w.counts).toBeDefined();
      expect(typeof w.counts.contributions_pending).toBe("number");
      expect(typeof w.counts.incoming_links).toBe("number");
      expect(typeof w.counts.outgoing_links).toBe("number");
    }

    // Computability has 1 incoming (CS History) and 1 outgoing (Turing)
    const computability = data.wikis.find((w: any) => w.label === "Computability");
    expect(computability.counts.incoming_links).toBe(1);
    expect(computability.counts.outgoing_links).toBe(1);
  });
});

describe("include=content on detail endpoint", () => {
  it("returns file content when requested", async () => {
    const wikis = await getWikis();
    const wiki = wikis.find((w: any) => w.label === "Alan Turing");
    expect(wiki).toBeTruthy();

    const withContent = await api(`/wikis/${wiki.id}?include=content`);
    expect(withContent.content).toBeTruthy();
    expect(typeof withContent.content).toBe("string");
    expect(withContent.content).toContain("Alan Turing");
    expect(withContent.content).toContain("---");
  });

  it("does not return content without the flag", async () => {
    const wikis = await getWikis();
    const wiki = wikis[0];

    const withoutContent = await api(`/wikis/${wiki.id}`);
    expect(withoutContent.content).toBeUndefined();
  });

  it("returns null content for missing files", async () => {
    const wikis = await getWikis();
    const wiki = wikis.find((w: any) => w.label === "Quantum Entanglement");
    expect(wiki).toBeTruthy();

    // Delete the file manually (without going through the watcher)
    const absPath = join(testDir, wiki.source_path);
    if (existsSync(absPath)) unlinkSync(absPath);

    const result = await api(`/wikis/${wiki.id}?include=content`);
    expect(result.content).toBeNull();
  });
});

describe("wiki deletion via API", () => {
  it("deletes a wiki", async () => {
    const wikis = await getWikis();
    const toDelete = wikis.find((w: any) => w.label === "Complex Properties Test");
    expect(toDelete).toBeTruthy();

    const result = await api(`/wikis/${toDelete.id}`, { method: "DELETE" });
    expect(result.deleted).toBe(true);

    const after = await api(`/wikis/${toDelete.id}`);
    expect(after.error?.code).toBe("not_found");
  });

  it("returns 404 when deleting a source file via /wikis", async () => {
    const meeting = await getEntityBySourcePath(
      (await api("/spaces")).spaces[0].id,
      "notes/meeting.txt",
    );
    expect(meeting).toBeTruthy();
    const result = await api(`/wikis/${meeting!.id}`, { method: "DELETE" });
    expect(result.error?.code).toBe("not_found");
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
