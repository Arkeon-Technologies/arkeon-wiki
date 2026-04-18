// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  addEntityToSpace,
  apiRequest,
  createActor,
  createEntity,
  createRelationship,
  createSpace,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Entities CRUD", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey);
  });

  test("Create entity with properties", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("crud-create"),
      description: "A test entity",
    });
    expect(entity.id).toBeTruthy();
    expect(entity.properties.label).toContain("crud-create");
    expect(entity.properties.description).toBe("A test entity");
    expect(entity.ver).toBe(1);
  });

  test("Get entity by ID", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("crud-get"),
    });
    const { response, body } = await getJson(`/wiki/${entity.id}`, actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).entity.id).toBe(entity.id);
    expect((body as any).entity.properties.label).toBe(entity.properties.label);
  });

  test("Update entity with CAS (ver)", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: "version-1",
    });
    expect(entity.ver).toBe(1);

    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "version-2" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.ver).toBe(2);
    expect((body as any).entity.properties.label).toBe("version-2");
  });

  test("CAS conflict on stale ver returns 409", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: "cas-test",
    });

    // First update succeeds
    await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "cas-updated" } },
    });

    // Second update with stale ver=1 should fail with 409
    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "cas-stale" } },
    });
    expect(response.status).toBe(409);
    expect((body as any).error?.code).toBe("cas_conflict");
  });

  test("Delete entity", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("crud-delete"),
    });

    const { response } = await apiRequest(`/wiki/${entity.id}`, {
      method: "DELETE",
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(204);

    // Verify deleted
    const { response: getRes } = await getJson(`/wiki/${entity.id}`, actor.apiKey);
    expect(getRes.status).toBe(404);
  });

  test("Entity versions: list and get specific version", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: "v1-label",
    });

    // Update to create v2
    await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "v2-label" }, note: "second edit" },
    });

    // Small delay for background version writes
    await new Promise((r) => setTimeout(r, 500));

    // List versions
    const { response: listRes, body: listBody } = await getJson(
      `/wiki/${entity.id}/versions`,
      actor.apiKey,
    );
    expect(listRes.status).toBe(200);
    expect((listBody as any).versions.length).toBeGreaterThanOrEqual(2);

    // Get specific version 1
    const { response: v1Res, body: v1Body } = await getJson(
      `/wiki/${entity.id}/versions/1`,
      actor.apiKey,
    );
    expect(v1Res.status).toBe(200);
    expect((v1Body as any).ver).toBe(1);
    expect((v1Body as any).properties.label).toBe("v1-label");
  });

  test("Entity activity log", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("activity-log"),
    });

    // Update to generate activity
    await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 1, properties: { label: "activity-updated" } },
    });

    // Small delay for background activity writes
    await new Promise((r) => setTimeout(r, 500));

    const { response, body } = await getJson(
      `/wiki/${entity.id}/activity`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const actions = (body as any).activity.map((a: any) => a.action);
    expect(actions).toContain("entity_created");
  });

  test("Relationships: create, list, delete", async () => {
    const source = await createEntity(actor.apiKey, "note", {
      label: uniqueName("rel-source"),
    });
    const target = await createEntity(actor.apiKey, "note", {
      label: uniqueName("rel-target"),
    });

    // Create relationship
    const rel = await createRelationship(
      actor.apiKey,
      source.id,
      "references",
      target.id,
      { weight: 1 },
    );
    expect(rel.edge).toBeTruthy();
    expect(rel.edge.predicate).toBe("references");
    expect(rel.edge.source_id).toBe(source.id);
    expect(rel.edge.target_id).toBe(target.id);

    // List relationships
    const { response: listRes, body: listBody } = await getJson(
      `/wiki/${source.id}/relationships`,
      actor.apiKey,
    );
    expect(listRes.status).toBe(200);
    expect((listBody as any).relationships.length).toBeGreaterThan(0);
    expect(
      (listBody as any).relationships.some(
        (r: any) => r.target_id === target.id && r.predicate === "references",
      ),
    ).toBe(true);

    // Delete relationship
    const relId = rel.edge.id;
    const { response: deleteRes } = await apiRequest(`/relationships/${relId}`, {
      method: "DELETE",
      apiKey: actor.apiKey,
    });
    expect(deleteRes.status).toBe(204);

    // Verify deleted
    const { response: getRes } = await getJson(`/relationships/${relId}`, actor.apiKey);
    expect(getRes.status).toBe(404);
  });

  test("Relationships: 404 for nonexistent source entity", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: uniqueName("rel-404-target"),
    });

    const { response, body } = await jsonRequest(
      `/wiki/01AAAAAAAAAAAAAAAAAAAAAAAA/relationships`,
      {
        method: "POST",
        apiKey: actor.apiKey,
        json: { predicate: "references", target_id: target.id },
      },
    );
    expect(response.status).toBe(404);
    expect((body as any).error.code).toBe("not_found");
  });

  test("Filter entities by boolean property", async () => {
    const tag = uniqueName("bool-filter");
    // Create entity with boolean true
    const eTrue = await createEntity(actor.apiKey, "note", {
      label: tag,
      extracted: true,
    });
    // Create entity with boolean false
    const eFalse = await createEntity(actor.apiKey, "note", {
      label: tag,
      extracted: false,
    });

    // Filter for extracted:true
    const { response, body } = await getJson(
      `/entities?filter=label:${tag},extracted:true`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(eTrue.id);
    expect(ids).not.toContain(eFalse.id);

    // Filter for extracted:false
    const { body: bodyF } = await getJson(
      `/entities?filter=label:${tag},extracted:false`,
      actor.apiKey,
    );
    const idsF = (bodyF as any).entities.map((e: any) => e.id);
    expect(idsF).toContain(eFalse.id);
    expect(idsF).not.toContain(eTrue.id);
  });

  test("Filter entities by numeric property", async () => {
    const tag = uniqueName("num-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: tag,
      count: 42,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: tag,
      count: 99,
    });

    // Exact match
    const { body } = await getJson(
      `/entities?filter=label:${tag},count:42`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  test("Filter entities by string property (unchanged behavior)", async () => {
    const tag = uniqueName("str-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: tag,
      status: "active",
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: tag,
      status: "archived",
    });

    const { body } = await getJson(
      `/entities?filter=label:${tag},status:active`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  test("Filter entities by property negation (!:)", async () => {
    const tag = uniqueName("neg-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: tag,
      extracted: true,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: tag,
      extracted: false,
    });

    // Negate boolean
    const { body } = await getJson(
      `/entities?filter=label:${tag},extracted!:true`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e2.id);
    expect(ids).not.toContain(e1.id);
  });

  test("Filter entities by nested property (dot notation)", async () => {
    const tag = uniqueName("nested-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: tag,
      metadata: { source: "arxiv", year: 2024 },
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: tag,
      metadata: { source: "pubmed", year: 2023 },
    });

    // Filter nested string property
    const { response, body } = await getJson(
      `/entities?filter=label:${tag},metadata.source:arxiv`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  test("Filter with properties. prefix is normalized", async () => {
    const tag = uniqueName("prefix-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: tag,
      processed: true,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: tag,
      processed: false,
    });

    // Using "properties.processed" should work the same as "processed"
    const { response, body } = await getJson(
      `/entities?filter=label:${tag},properties.processed:true`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);

    // Also test nested with prefix
    const e3 = await createEntity(actor.apiKey, "note", {
      label: tag,
      metadata: { source: "arxiv" },
    });
    const { body: body2 } = await getJson(
      `/entities?filter=label:${tag},properties.metadata.source:arxiv`,
      actor.apiKey,
    );
    const ids2 = (body2 as any).entities.map((e: any) => e.id);
    expect(ids2).toContain(e3.id);
  });

  test("List entities with space_id filter returns only entities in that space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("filter-space"));
    const inSpace = await createEntity(actor.apiKey, "note", {
      label: uniqueName("in-space"),
    });
    const outside = await createEntity(actor.apiKey, "note", {
      label: uniqueName("outside-space"),
    });

    await addEntityToSpace(actor.apiKey, space.id, inSpace.id);

    const { response, body } = await getJson(
      `/entities?space_id=${space.id}`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(inSpace.id);
    expect(ids).not.toContain(outside.id);
  });

  test("List entities with space_id filter combines with other filters", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("combo-space"));
    const tag = uniqueName("combo-tag");
    const match = await createEntity(actor.apiKey, "note", {
      label: tag,
      status: "active",
    });
    const noMatch = await createEntity(actor.apiKey, "note", {
      label: tag,
      status: "archived",
    });

    await addEntityToSpace(actor.apiKey, space.id, match.id);
    await addEntityToSpace(actor.apiKey, space.id, noMatch.id);

    const { response, body } = await getJson(
      `/entities?space_id=${space.id}&filter=status:active`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(noMatch.id);
  });

  test("List entities without space_id returns all entities", async () => {
    const tag = uniqueName("no-space-filter");
    const entity = await createEntity(actor.apiKey, "note", {
      label: tag,
    });

    const { response, body } = await getJson(
      `/entities?filter=label:${tag}`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(entity.id);
  });
});
