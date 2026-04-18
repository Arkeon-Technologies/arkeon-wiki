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

type WikiResponse = {
  wiki: {
    id: string;
    type: string;
    ver: number;
    properties: Record<string, unknown>;
  };
  placeholders: Array<{ id: string; label: string; status: string }>;
  relationships_created: number;
  resolve_warnings?: unknown[];
};

type EntityResponse = {
  entity: {
    id: string;
    type: string;
    kind?: string;
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

async function createWiki(
  apiKey: string,
  label: string,
  content: string,
  opts?: { spaceId?: string; subjectType?: string },
) {
  const { response, body } = await jsonRequest("/wiki", {
    method: "POST",
    apiKey,
    json: {
      label,
      content,
      keywords: [label.toLowerCase()],
      short_description: `Test wiki: ${label}`,
      subject_type: opts?.subjectType ?? "document",
      ...(opts?.spaceId ? { space_id: opts.spaceId } : {}),
    },
  });
  expect(response.status).toBe(201);
  return body as WikiResponse;
}

async function listDocuments(apiKey: string, spaceId: string) {
  const { body } = await getJson(
    `/wiki?filter=${encodeURIComponent("properties.subject_type:document")}&space_id=${spaceId}&limit=200`,
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

  test("add: create document wikis", async () => {
    const d1 = await createWiki(actor.apiKey, "Book 01", "Augustine reflects on his early life.", { spaceId, subjectType: "document" });
    const d2 = await createWiki(actor.apiKey, "Book 02", "Augustine discusses the nature of sin.", { spaceId, subjectType: "document" });
    const d3 = await createWiki(actor.apiKey, "City of God", "A treatise on the two cities.", { spaceId, subjectType: "document" });

    doc1Id = d1.wiki.id;
    doc2Id = d2.wiki.id;
    doc3Id = d3.wiki.id;

    expect(doc1Id).toBeTruthy();
    expect(doc2Id).toBeTruthy();
    expect(doc3Id).toBeTruthy();
  });

  test("diff: space now has 3 documents", async () => {
    const docs = await listDocuments(actor.apiKey, spaceId);
    expect(docs).toHaveLength(3);
  });

  test("diff: documents have correct properties", async () => {
    const entity = await getEntity(actor.apiKey, doc1Id);
    expect(entity).not.toBeNull();
    expect(entity!.properties.label).toBe("Book 01");
    expect(entity!.properties.content).toBeTruthy();
  });

  // --- Update flow (simulate modified content) ---

  test("add (update): modify document properties in place", async () => {
    const entity = await getEntity(actor.apiKey, doc1Id);
    expect(entity).not.toBeNull();

    const status = await updateEntity(actor.apiKey, doc1Id, entity!.ver, {
      short_description: "Updated description for Book 01.",
    });
    expect(status).toBe(200);

    // Verify entity ID is stable
    const updated = await getEntity(actor.apiKey, doc1Id);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(doc1Id); // same ID
    expect(updated!.properties.short_description).toBe("Updated description for Book 01.");
    // Original properties preserved (shallow merge)
    expect(updated!.properties.label).toBe("Book 01");
  });

  // --- Wiki links create relationships ---

  let linkedWikiId: string;

  test("add: wiki with entity link creates relationship", async () => {
    const result = await createWiki(
      actor.apiKey,
      "Analysis of Book 01",
      `This analysis references [[entity:${doc1Id}]] extensively.`,
      { spaceId },
    );

    linkedWikiId = result.wiki.id;
    expect(result.relationships_created).toBeGreaterThanOrEqual(1);
  });

  test("relationships: linked wiki has references relationship", async () => {
    const rels = await getIncomingRelationships(actor.apiKey, doc1Id, "references");
    const fromLinkedWiki = rels.filter((r) => r.source_id === linkedWikiId);
    expect(fromLinkedWiki.length).toBeGreaterThanOrEqual(1);
  });

  // --- Remove flow ---

  test("rm: delete document wiki", async () => {
    const status = await deleteEntity(actor.apiKey, doc3Id);
    expect(status).toBe(204);
    expect(await getEntity(actor.apiKey, doc3Id)).toBeNull();
  });

  test("rm: remaining documents are unaffected", async () => {
    const docs = await listDocuments(actor.apiKey, spaceId);
    // doc1, doc2, and the linked "Analysis" wiki remain (doc3 deleted)
    const labels = docs.map((d) => d.properties.label).sort();
    expect(labels).toEqual(["Analysis of Book 01", "Book 01", "Book 02"]);
  });

  // --- Simple delete (no extracted children) ---

  test("rm: delete document with no children", async () => {
    const status = await deleteEntity(actor.apiKey, doc2Id);
    expect(status).toBe(204);

    const docs = await listDocuments(actor.apiKey, spaceId);
    // Book 01 and Analysis of Book 01 remain
    expect(docs).toHaveLength(2);
    const labels = docs.map((d) => d.properties.label).sort();
    expect(labels).toEqual(["Analysis of Book 01", "Book 01"]);
  });
});

describe("Repo commands — wiki placeholder behavior", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;
  let spaceId: string;

  test("setup", async () => {
    const result = await createSpaceWithActor(uniqueName("placeholder-test"));
    actor = result.actor;
    spaceId = result.space.id;
  });

  test("wiki with placeholder links creates stub entities", async () => {
    const result = await createWiki(
      actor.apiKey,
      "Test Subject",
      'This wiki mentions [[placeholder:"Person A"|"A test person"]] and [[placeholder:"Person B"|"Another test person"]].',
      { spaceId },
    );

    expect(result.placeholders).toHaveLength(2);
    const labels = result.placeholders.map((p) => p.label).sort();
    expect(labels).toEqual(["Person A", "Person B"]);
    expect(result.relationships_created).toBeGreaterThanOrEqual(2);
  });

  test("deleting a wiki preserves placeholder entities", async () => {
    const result = await createWiki(
      actor.apiKey,
      "Another Subject",
      'References [[placeholder:"Concept X"|"A test concept"]].',
      { spaceId },
    );

    const placeholderId = result.placeholders[0]!.id;
    const wikiId = result.wiki.id;

    // Delete the wiki
    const status = await deleteEntity(actor.apiKey, wikiId);
    expect(status).toBe(204);

    // Placeholder should still exist
    const placeholder = await getEntity(actor.apiKey, placeholderId);
    expect(placeholder).not.toBeNull();
  });
});
