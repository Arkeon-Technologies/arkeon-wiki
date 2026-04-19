// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for `arkeon pull` and the enhanced `arkeon add` workflow.
 *
 * Tests the full round-trip: create wikis via API → pull to disk →
 * edit locally → add back → verify server state.
 */

import { describe, expect, test, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  adminApiKey,
  baseUrl,
  createActor,
  createSpace,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

import { loadManifest, saveManifest } from "../../src/cli/lib/manifest";
import { serializeEntity, parseEntityFile } from "../../src/cli/lib/wiki-serialization";

// ---------------------------------------------------------------------------
// Test fixtures — create a space with some wiki entities
// ---------------------------------------------------------------------------

let testDir: string;
let spaceId: string;
let actorKey: string;
let wikiIds: string[];

beforeAll(async () => {
  // Create temp directory simulating a repo root
  testDir = join(tmpdir(), `arkeon-pull-add-e2e-${Date.now()}`);
  mkdirSync(join(testDir, ".arkeon"), { recursive: true });

  // Create actor + space
  const actor = await createActor(adminApiKey, {
    properties: { label: uniqueName("pull-test-ingestor") },
  });
  actorKey = actor.apiKey;

  const space = await createSpace(actorKey, uniqueName("pull-test-space"));
  spaceId = space.id;

  // Write repo state
  writeFileSync(
    join(testDir, ".arkeon", "state.json"),
    JSON.stringify({
      api_url: baseUrl,
      space_id: spaceId,
      space_name: "pull-test-space",
      actors: { ingestor: { actor_id: actor.id } },
      created_at: new Date().toISOString(),
    }),
  );

  // Create 3 wiki entities in the space
  wikiIds = [];
  const wikis = [
    {
      label: "Entropy",
      content: "Entropy is a measure of disorder in thermodynamics.",
      subject_type: "concept",
      keywords: ["entropy", "thermodynamics"],
      short_description: "Thermodynamic entropy.",
    },
    {
      label: "Claude Shannon",
      content: "Claude Shannon was the father of information theory.",
      subject_type: "person",
      keywords: ["shannon", "information theory"],
      short_description: "Father of information theory.",
      aliases: ["C.E. Shannon"],
    },
    {
      label: "Misc Note",
      content: "A note without a subject type.",
      keywords: ["misc"],
      short_description: "A miscellaneous note.",
    },
  ];

  for (const wiki of wikis) {
    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actorKey,
      json: { ...wiki, space_id: spaceId },
    });
    expect(response.status).toBe(201);
    wikiIds.push((body as any).wiki.id);
  }
});

afterAll(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Serialization e2e: verify against real API responses
// ---------------------------------------------------------------------------

describe("serialization against real API entities", () => {
  test("serializeEntity produces valid markdown from real entity", async () => {
    const { response, body } = await getJson(`/wiki/${wikiIds[0]}?view=full`, actorKey);
    expect(response.status).toBe(200);

    const entity = (body as any).entity;
    const md = serializeEntity(entity);

    // Should have frontmatter
    expect(md).toMatch(/^---\n/);
    expect(md).toContain(`id: ${wikiIds[0]}`);
    expect(md).toContain("subject_type: concept");
    expect(md).toContain("# Entropy");
    expect(md).toContain("measure of disorder");
  });

  test("round-trip: serialize then parse preserves fields", async () => {
    const { body } = await getJson(`/wiki/${wikiIds[1]}?view=full`, actorKey);
    const entity = (body as any).entity;

    const md = serializeEntity(entity);
    const parsed = parseEntityFile(md);

    expect(parsed.id).toBe(wikiIds[1]);
    expect(parsed.label).toBe("Claude Shannon");
    expect(parsed.subject_type).toBe("person");
    expect(parsed.keywords).toContain("shannon");
    expect(parsed.content).toContain("father of information theory");
  });
});

// ---------------------------------------------------------------------------
// Pull simulation: fetch entities, write to disk, verify manifest
// ---------------------------------------------------------------------------

describe("pull workflow", () => {
  test("fetches entities and writes markdown files", async () => {
    // Simulate what `arkeon pull` does
    const manifest = loadManifest(testDir);
    const { entityToFilePath } = await import("../../src/cli/lib/manifest");
    const { contentHash } = await import("../../src/cli/lib/manifest");
    const { dirname } = await import("node:path");

    // Fetch all entities from space
    const { body } = await getJson(
      `/wiki?space_id=${spaceId}&limit=200`,
      actorKey,
    );
    const entities = (body as any).entities as Array<{
      id: string;
      ver: number;
      properties: Record<string, unknown>;
    }>;

    // Should have at least our 3 wikis (may also have relationship entities, but
    // the list endpoint filters those out by default)
    expect(entities.length).toBeGreaterThanOrEqual(3);

    // Write each to disk
    for (const entity of entities) {
      const filePath = entityToFilePath(entity, manifest);
      const content = serializeEntity(entity);
      const absPath = join(testDir, filePath);

      mkdirSync(join(testDir, dirname(filePath)), { recursive: true });
      writeFileSync(absPath, content, "utf-8");

      manifest.entries[filePath] = {
        entity_id: entity.id,
        ver: entity.ver,
        content_hash: contentHash(absPath),
        pulled_at: new Date().toISOString(),
      };
    }

    saveManifest(manifest, testDir);

    // Verify files exist
    expect(existsSync(join(testDir, "wiki/concept/entropy.md"))).toBe(true);
    expect(existsSync(join(testDir, "wiki/person/claude-shannon.md"))).toBe(true);

    // Verify manifest
    const loaded = loadManifest(testDir);
    expect(Object.keys(loaded.entries).length).toBeGreaterThanOrEqual(3);
    expect(loaded.entries["wiki/concept/entropy.md"]?.entity_id).toBe(wikiIds[0]);
    expect(loaded.entries["wiki/person/claude-shannon.md"]?.entity_id).toBe(wikiIds[1]);
  });
});

// ---------------------------------------------------------------------------
// Add workflow: edit a pulled file, push back, verify server state
// ---------------------------------------------------------------------------

describe("add workflow for frontmatter entities", () => {
  test("editing a pulled file and pushing back updates the entity", async () => {
    const entryPath = "wiki/concept/entropy.md";
    const absPath = join(testDir, entryPath);

    // Read the current file
    const original = readFileSync(absPath, "utf-8");
    expect(original).toContain("# Entropy");

    // Edit: add a new paragraph
    const edited = original.replace(
      "measure of disorder in thermodynamics.",
      "measure of disorder in thermodynamics.\n\nIt is central to the second law.",
    );
    writeFileSync(absPath, edited, "utf-8");

    // Parse the edited file
    const parsed = parseEntityFile(edited);
    expect(parsed.id).toBe(wikiIds[0]);
    expect(parsed.content).toContain("second law");

    // Simulate what enhanced `add` does: PUT /wiki/{id}
    const properties: Record<string, unknown> = {
      content: parsed.content,
      label: parsed.label,
    };
    if (parsed.subject_type) properties.subject_type = parsed.subject_type;
    if (parsed.keywords) properties.keywords = parsed.keywords;
    if (parsed.short_description) properties.short_description = parsed.short_description;

    const { response, body } = await jsonRequest(`/wiki/${parsed.id}`, {
      method: "PUT",
      apiKey: actorKey,
      json: { ver: parsed.ver, properties },
    });

    expect(response.status).toBe(200);
    const updated = (body as any).entity;
    expect(updated.ver).toBeGreaterThan(parsed.ver!);

    // Verify server has the new content
    const { body: fetchBody } = await getJson(
      `/wiki/${wikiIds[0]}?view=full`,
      actorKey,
    );
    const serverEntity = (fetchBody as any).entity;
    expect(serverEntity.properties.content).toContain("second law");
    // submitted_content should also have the new text
    expect(serverEntity.properties.submitted_content).toContain("second law");
  });

  test("adding a file with wiki links triggers relationship creation", async () => {
    // Create a new wiki that references an existing entity via link syntax
    const entryPath = "wiki/concept/information-entropy.md";
    const absPath = join(testDir, entryPath);
    mkdirSync(join(testDir, "wiki/concept"), { recursive: true });

    const md = [
      "---",
      "subject_type: concept",
      "keywords:",
      "  - information entropy",
      "  - shannon entropy",
      `short_description: Shannon's entropy formula.`,
      "---",
      "",
      "# Information Entropy",
      "",
      `Shannon defined entropy as H = -sum(p log p). See also [[entity:${wikiIds[1]}]].`,
    ].join("\n");

    writeFileSync(absPath, md, "utf-8");

    // Parse — no id means it's a new entity
    const parsed = parseEntityFile(md);
    expect(parsed.id).toBeUndefined();
    expect(parsed.label).toBe("Information Entropy");

    // Create via POST /wiki (what `add` does for new files)
    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actorKey,
      json: {
        label: parsed.label,
        content: parsed.content,
        subject_type: parsed.subject_type,
        keywords: parsed.keywords,
        short_description: parsed.short_description,
        space_id: spaceId,
      },
    });

    expect(response.status).toBe(201);
    const created = (body as any).wiki;
    expect(created.id).toBeTruthy();

    // The [[entity:...]] link should have created a relationship
    const relCount = (body as any).relationships_created;
    expect(relCount).toBe(1);

    // Verify the relationship exists
    const { body: relBody } = await getJson(
      `/wiki/${created.id}/relationships?limit=10`,
      actorKey,
    );
    const rels = (relBody as any).relationships;
    expect(rels.length).toBeGreaterThanOrEqual(1);
    const refRel = rels.find(
      (r: any) => r.target_id === wikiIds[1] && r.predicate === "references",
    );
    expect(refRel).toBeTruthy();
  });

  test("CAS conflict on stale ver returns 409", async () => {
    // Try to update with an old ver
    const { response } = await jsonRequest(`/wiki/${wikiIds[0]}`, {
      method: "PUT",
      apiKey: actorKey,
      json: {
        ver: 1, // stale
        properties: { content: "Stale update attempt." },
      },
    });

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Uncategorized entity handling
// ---------------------------------------------------------------------------

describe("uncategorized entities", () => {
  test("entity without subject_type gets _uncategorized directory", async () => {
    const { body } = await getJson(`/wiki/${wikiIds[2]}?view=full`, actorKey);
    const entity = (body as any).entity;

    const { entityToFilePath } = await import("../../src/cli/lib/manifest");
    const manifest = loadManifest(testDir);
    const path = entityToFilePath(entity, manifest);

    expect(path).toMatch(/^wiki\/_uncategorized\//);
  });
});
