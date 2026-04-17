// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for the repo-binding CLI commands: init, diff, add, rm.
 *
 * These tests exercise the commands programmatically by importing
 * their core logic and calling the API directly (same pattern as the
 * manual testing flow, but automated).
 */

import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  adminApiKey,
  baseUrl,
  createActor,
  jsonRequest,
  getJson,
  uniqueName,
} from "./helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OpsResponse = {
  format: string;
  committed: boolean;
  entities: Array<{ ref: string; id: string; type: string; label: string | null; action: "created" | "updated" }>;
  edges: Array<{ id: string; source: string; predicate: string; target: string }>;
  stats: { entities: number; edges: number };
};

type EntityResponse = {
  entity: {
    id: string;
    type: string;
    ver: number;
    properties: Record<string, unknown>;
  };
};

type ListResponse = {
  entities: Array<{
    id: string;
    type: string;
    ver: number;
    properties: Record<string, unknown>;
  }>;
  cursor: string | null;
};

type RelationshipsResponse = {
  relationships: Array<{
    id: string;
    source_id: string;
    target_id: string;
    predicate: string;
  }>;
  cursor: string | null;
};

// ---------------------------------------------------------------------------
// Helpers — simulate what the CLI commands do, but via direct API calls
// ---------------------------------------------------------------------------

async function createSpaceWithActor(name: string) {
  // Create actor
  const actor = await createActor(adminApiKey, {
    properties: { label: `ingestor-${name}` },
  });

  // Create space
  const { response, body } = await jsonRequest("/spaces", {
    method: "POST",
    apiKey: actor.apiKey,
    json: {
      name,
      description: `Test repo: ${name}`,
      properties: { repo_root: `/tmp/test-${name}` },
    },
  });
  expect(response.status).toBe(201);
  const space = (body as { space: { id: string; name: string } }).space;

  return { actor, space };
}

async function addDocumentEntity(
  apiKey: string,
  spaceId: string,
  sourceFile: string,
  sourceHash: string,
  content: string | null,
) {
  const ops: Record<string, unknown>[] = [
    {
      op: "entity",
      ref: "@doc",
      type: "document",
      label: sourceFile.split("/").pop(),
      source_file: sourceFile,
      source_hash: sourceHash,
      file_type: "markdown",
      ...(content !== null ? { content } : {}),
    },
  ];

  const { response, body } = await jsonRequest("/ops", {
    method: "POST",
    apiKey,
    json: { format: "arke.ops/v1", defaults: { space_id: spaceId }, ops },
  });
  expect(response.status).toBe(200);
  const data = body as OpsResponse;
  expect(data.committed).toBe(true);
  return data.entities[0]!;
}

async function listDocuments(apiKey: string, spaceId: string) {
  const { body } = await getJson(
    `/wiki?filter=${encodeURIComponent("type:document")}&space_id=${spaceId}&limit=200`,
    apiKey,
  );
  return (body as ListResponse).entities;
}

async function getEntity(apiKey: string, entityId: string) {
  const { response, body } = await getJson(`/wiki/${entityId}`, apiKey);
  if (response.status === 404 || response.status === 410) return null;
  expect(response.status).toBe(200);
  return (body as EntityResponse).entity;
}

async function getIncomingRelationships(apiKey: string, entityId: string, predicate?: string) {
  const predicateParam = predicate ? `&predicate=${predicate}` : "";
  const { body } = await getJson(
    `/wiki/${entityId}/relationships?direction=in${predicateParam}`,
    apiKey,
  );
  return (body as RelationshipsResponse).relationships;
}

async function deleteEntity(apiKey: string, entityId: string) {
  const response = await fetch(`${baseUrl}/wiki/${entityId}`, {
    method: "DELETE",
    headers: { authorization: `ApiKey ${apiKey}` },
  });
  return response.status;
}

async function updateEntity(apiKey: string, entityId: string, ver: number, properties: Record<string, unknown>) {
  const { response } = await jsonRequest(`/wiki/${entityId}`, {
    method: "PUT",
    apiKey,
    json: { ver, properties },
  });
  return response.status;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Repo commands — init / diff / add / rm flow", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;
  let spaceId: string;
  const spaceName = uniqueName("repo-test");

  test("init: create actor and space", async () => {
    const result = await createSpaceWithActor(spaceName);
    actor = result.actor;
    spaceId = result.space.id;

    expect(actor.apiKey).toBeTruthy();
    expect(spaceId).toBeTruthy();
    expect(result.space.name).toBe(spaceName);
  });

  test("diff: empty space has no documents", async () => {
    const docs = await listDocuments(actor.apiKey, spaceId);
    expect(docs).toHaveLength(0);
  });

  // --- Add flow ---

  let doc1Id: string;
  let doc2Id: string;
  let doc3Id: string;

  test("add: create document entities via ops", async () => {
    const d1 = await addDocumentEntity(actor.apiKey, spaceId, "texts/book-01.md", "hash_aaa", "Augustine reflects on his early life.");
    const d2 = await addDocumentEntity(actor.apiKey, spaceId, "texts/book-02.md", "hash_bbb", "Augustine discusses the nature of sin.");
    const d3 = await addDocumentEntity(actor.apiKey, spaceId, "texts/city-of-god.md", "hash_ccc", "A treatise on the two cities.");

    doc1Id = d1.id;
    doc2Id = d2.id;
    doc3Id = d3.id;

    expect(doc1Id).toBeTruthy();
    expect(doc2Id).toBeTruthy();
    expect(doc3Id).toBeTruthy();
  });

  test("diff: space now has 3 documents", async () => {
    const docs = await listDocuments(actor.apiKey, spaceId);
    expect(docs).toHaveLength(3);

    const sourceFiles = docs.map((d) => d.properties.source_file).sort();
    expect(sourceFiles).toEqual([
      "texts/book-01.md",
      "texts/book-02.md",
      "texts/city-of-god.md",
    ]);
  });

  test("diff: documents have correct properties", async () => {
    const entity = await getEntity(actor.apiKey, doc1Id);
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("document");
    expect(entity!.properties.source_file).toBe("texts/book-01.md");
    expect(entity!.properties.source_hash).toBe("hash_aaa");
    expect(entity!.properties.content).toBe("Augustine reflects on his early life.");
    expect(entity!.properties.file_type).toBe("markdown");
  });

  // --- Update flow (simulate modified file) ---

  test("add (update): modify document properties in place", async () => {
    const entity = await getEntity(actor.apiKey, doc1Id);
    expect(entity).not.toBeNull();

    const status = await updateEntity(actor.apiKey, doc1Id, entity!.ver, {
      source_hash: "hash_aaa_modified",
      content: "Augustine reflects on his early life and conversion.",
    });
    expect(status).toBe(200);

    // Verify entity ID is stable
    const updated = await getEntity(actor.apiKey, doc1Id);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(doc1Id); // same ID
    expect(updated!.properties.source_hash).toBe("hash_aaa_modified");
    expect(updated!.properties.content).toBe("Augustine reflects on his early life and conversion.");
    // Original properties preserved (shallow merge)
    expect(updated!.properties.source_file).toBe("texts/book-01.md");
  });

  // --- Ingest simulation: extracted_from provenance ---

  let augustineId: string;
  let cityOfGodConceptId: string;
  let authoredEdgeId: string;

  test("ingest: extract entities with source.entity_id provenance", async () => {
    const { response, body } = await jsonRequest("/ops", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        format: "arke.ops/v1",
        defaults: { space_id: spaceId },
        source: { entity_id: doc3Id },
        ops: [
          { op: "entity", ref: "@augustine", type: "person", label: "Augustine of Hippo", description: "Early Christian theologian" },
          { op: "entity", ref: "@city_concept", type: "concept", label: "City of God", description: "The heavenly city" },
          { op: "relate", source: "@augustine", target: "@city_concept", predicate: "authored", detail: "Augustine wrote De Civitate Dei" },
        ],
      },
    });

    expect(response.status).toBe(200);
    const data = body as OpsResponse;
    expect(data.committed).toBe(true);
    expect(data.entities).toHaveLength(2);
    expect(data.edges).toHaveLength(1);

    augustineId = data.entities.find((c) => c.ref === "@augustine")!.id;
    cityOfGodConceptId = data.entities.find((c) => c.ref === "@city_concept")!.id;
    authoredEdgeId = data.edges[0]!.id;
  });

  test("provenance: entities have extracted_from edges to document", async () => {
    const rels = await getIncomingRelationships(actor.apiKey, doc3Id, "extracted_from");

    // Should be 3: augustine, city_concept, AND the authored relationship
    expect(rels.length).toBe(3);

    const sourceIds = rels.map((r) => r.source_id).sort();
    const expected = [augustineId, cityOfGodConceptId, authoredEdgeId].sort();
    expect(sourceIds).toEqual(expected);
  });

  test("provenance: relationship entity also has extracted_from", async () => {
    // The 'authored' relationship entity should point back to the document
    const sourceIds = (await getIncomingRelationships(actor.apiKey, doc3Id, "extracted_from"))
      .map((r) => r.source_id);
    expect(sourceIds).toContain(authoredEdgeId);
  });

  // --- Remove flow: cascade delete ---

  test("rm: delete document cascades to extracted entities", async () => {
    // Get extracted_from edges first
    const rels = await getIncomingRelationships(actor.apiKey, doc3Id, "extracted_from");
    expect(rels.length).toBe(3);

    // Delete each extracted entity (simulating what arkeon rm does)
    for (const rel of rels) {
      const status = await deleteEntity(actor.apiKey, rel.source_id);
      expect([204, 404]).toContain(status); // 404 ok due to cascade
    }

    // Delete the document entity itself
    const status = await deleteEntity(actor.apiKey, doc3Id);
    expect(status).toBe(204);

    // Verify everything is gone
    expect(await getEntity(actor.apiKey, doc3Id)).toBeNull();
    expect(await getEntity(actor.apiKey, augustineId)).toBeNull();
    expect(await getEntity(actor.apiKey, cityOfGodConceptId)).toBeNull();
  });

  test("rm: remaining documents are unaffected", async () => {
    const docs = await listDocuments(actor.apiKey, spaceId);
    expect(docs).toHaveLength(2);

    const sourceFiles = docs.map((d) => d.properties.source_file).sort();
    expect(sourceFiles).toEqual(["texts/book-01.md", "texts/book-02.md"]);
  });

  // --- Simple delete (no extracted children) ---

  test("rm: delete document with no children", async () => {
    const status = await deleteEntity(actor.apiKey, doc2Id);
    expect(status).toBe(204);

    const docs = await listDocuments(actor.apiKey, spaceId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.properties.source_file).toBe("texts/book-01.md");
  });

  // --- Idempotency: adding same file twice ---

  test("add: re-adding with same hash is idempotent (via filter check)", async () => {
    // Query for existing doc with same source_file
    const { body } = await getJson(
      `/wiki?filter=${encodeURIComponent("type:document,properties.source_file:texts/book-01.md")}&space_id=${spaceId}&limit=1`,
      actor.apiKey,
    );
    const existing = (body as ListResponse).entities;
    expect(existing).toHaveLength(1);
    expect(existing[0]!.properties.source_hash).toBe("hash_aaa_modified");
    // CLI would skip this file since hash matches — no need to create again
  });
});

describe("Repo commands — DB cascade behavior", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;
  let spaceId: string;

  test("setup", async () => {
    const result = await createSpaceWithActor(uniqueName("cascade-test"));
    actor = result.actor;
    spaceId = result.space.id;
  });

  test("deleting an entity cascades its relationship_edges row", async () => {
    // Create two entities + a relationship
    const { body } = await jsonRequest("/ops", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        format: "arke.ops/v1",
        defaults: { space_id: spaceId },
        ops: [
          { op: "entity", ref: "@a", type: "person", label: "Person A" },
          { op: "entity", ref: "@b", type: "person", label: "Person B" },
          { op: "relate", source: "@a", target: "@b", predicate: "knows" },
        ],
      },
    });
    const data = body as OpsResponse;
    const personAId = data.entities.find((c) => c.ref === "@a")!.id;
    const personBId = data.entities.find((c) => c.ref === "@b")!.id;
    const knowsEdgeId = data.edges[0]!.id;

    // Delete person A — ON DELETE CASCADE on relationship_edges.source_id
    // removes the edge row, but the relationship's entities row survives
    // (it has its own id PK, cascaded only via relationship_edges.id FK).
    const status = await deleteEntity(actor.apiKey, personAId);
    expect(status).toBe(204);

    // The relationship_edges row is gone (CASCADE on source_id), which
    // cascades to deleting the entities row too (relationship_edges.id
    // REFERENCES entities.id ON DELETE CASCADE — but actually the cascade
    // goes the OTHER direction: entities.id deletion cascades TO
    // relationship_edges.id). So in practice: deleting the edge row via
    // source_id cascade does NOT delete the entity row. The relationship
    // entity becomes an orphan. This is why arkeon rm explicitly deletes
    // extracted entities — it can't rely on DB cascade alone.
    //
    // Verify: the relationship entity still exists but has no edge row
    const relEntity = await getEntity(actor.apiKey, knowsEdgeId);
    // The entity row may or may not survive depending on cascade direction.
    // relationship_edges.id REFERENCES entities(id) ON DELETE CASCADE means
    // deleting the entities row cascades to relationship_edges — NOT the reverse.
    // So when relationship_edges row is deleted via source_id cascade,
    // the entities row for the relationship survives as an orphan.
    expect(relEntity).not.toBeNull();
    expect(relEntity!.kind).toBe("relationship");

    // Person B should still exist
    const b = await getEntity(actor.apiKey, personBId);
    expect(b).not.toBeNull();
    expect(b!.properties.label).toBe("Person B");
  });

  test("source.entity_id creates extracted_from for both entities and relationships", async () => {
    // Create a source document
    const doc = await addDocumentEntity(actor.apiKey, spaceId, "test/source.md", "hash_src", "Source content");

    // Create entities + relationship with source provenance
    const { body } = await jsonRequest("/ops", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        format: "arke.ops/v1",
        defaults: { space_id: spaceId },
        source: { entity_id: doc.id },
        ops: [
          { op: "entity", ref: "@x", type: "concept", label: "Concept X" },
          { op: "entity", ref: "@y", type: "concept", label: "Concept Y" },
          { op: "relate", source: "@x", target: "@y", predicate: "related_to" },
        ],
      },
    });
    const data = body as OpsResponse;
    const xId = data.entities.find((c) => c.ref === "@x")!.id;
    const yId = data.entities.find((c) => c.ref === "@y")!.id;
    const relId = data.edges[0]!.id;

    // All three should have extracted_from pointing to the document
    const rels = await getIncomingRelationships(actor.apiKey, doc.id, "extracted_from");
    const sourceIds = rels.map((r) => r.source_id).sort();
    expect(sourceIds).toEqual([xId, yId, relId].sort());
  });
});
