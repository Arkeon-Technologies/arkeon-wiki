// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  addEntityToSpace,
  apiRequest,
  createActor,
  createEntity,
  createSpace,
  createWikiWithLinks,
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
    // Wiki publish cycle creates ver=2 (draft=1, publish=2)
    expect(entity.ver).toBe(2);
  });

  test("Get entity by ID", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("crud-get"),
    });
    const { response, body } = await getJson(`/wiki/${entity.id}`, actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).wiki.id).toBe(entity.id);
    expect((body as any).wiki.properties.label).toBe(entity.properties.label);
  });

  test("Update entity with CAS (ver)", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("version-1"),
    });
    // Wiki publish cycle creates ver=2
    expect(entity.ver).toBe(2);

    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 2, properties: { label: "version-2" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).wiki.ver).toBe(3);
    expect((body as any).wiki.properties.label).toBe("version-2");
  });

  test("CAS conflict on stale ver returns 409", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("cas-test"),
    });

    // First update succeeds (entity starts at ver=2 after publish)
    await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 2, properties: { label: "cas-updated" } },
    });

    // Second update with stale ver=2 should fail with 409
    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 2, properties: { label: "cas-stale" } },
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
      label: uniqueName("v1-label"),
    });

    // Update to create v3 (entity starts at ver=2 after publish)
    await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: 2, properties: { label: "v2-label" }, note: "second edit" },
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
    expect((v1Body as any).properties.label).toContain("v1-label");
  });

  test("Relationships: create via wiki links and list", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: uniqueName("rel-target"),
    });

    // Create a wiki with a link to target — this creates a "references" relationship
    const source = await createWikiWithLinks(
      actor.apiKey,
      uniqueName("rel-source"),
      [target.id],
    );

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
  });

  test("Relationships: empty list for nonexistent entity", async () => {
    // GET relationships for a nonexistent entity returns empty list
    const { response, body } = await getJson(
      `/wiki/01AAAAAAAAAAAAAAAAAAAAAAAA/relationships`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    expect((body as any).relationships).toEqual([]);
  });

  test("Filter entities by boolean property", async () => {
    const tag = uniqueName("bool-filter");
    // Create entities with unique labels to avoid wiki duplicate detection
    const eTrue = await createEntity(actor.apiKey, "note", {
      label: `${tag}-true`,
      group_tag: tag,
      extracted: true,
    });
    const eFalse = await createEntity(actor.apiKey, "note", {
      label: `${tag}-false`,
      group_tag: tag,
      extracted: false,
    });

    // Filter for extracted:true within this group
    const { response, body } = await getJson(
      `/wiki?filter=group_tag:${tag},extracted:true`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(eTrue.id);
    expect(ids).not.toContain(eFalse.id);

    // Filter for extracted:false
    const { body: bodyF } = await getJson(
      `/wiki?filter=group_tag:${tag},extracted:false`,
      actor.apiKey,
    );
    const idsF = (bodyF as any).entities.map((e: any) => e.id);
    expect(idsF).toContain(eFalse.id);
    expect(idsF).not.toContain(eTrue.id);
  });

  test("Filter entities by numeric property", async () => {
    const tag = uniqueName("num-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-a`,
      group_tag: tag,
      count: 42,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-b`,
      group_tag: tag,
      count: 99,
    });

    // Exact match
    const { body } = await getJson(
      `/wiki?filter=group_tag:${tag},count:42`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  test("Filter entities by string property (unchanged behavior)", async () => {
    const tag = uniqueName("str-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-active`,
      group_tag: tag,
      filter_status: "active",
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-archived`,
      group_tag: tag,
      filter_status: "archived",
    });

    const { body } = await getJson(
      `/wiki?filter=group_tag:${tag},filter_status:active`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  test("Filter entities by property negation (!:)", async () => {
    const tag = uniqueName("neg-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-true`,
      group_tag: tag,
      extracted: true,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-false`,
      group_tag: tag,
      extracted: false,
    });

    // Negate boolean
    const { body } = await getJson(
      `/wiki?filter=group_tag:${tag},extracted!:true`,
      actor.apiKey,
    );
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e2.id);
    expect(ids).not.toContain(e1.id);
  });

  test("Filter entities by nested property (dot notation)", async () => {
    const tag = uniqueName("nested-filter");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-arxiv`,
      group_tag: tag,
      metadata: { source: "arxiv", year: 2024 },
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-pubmed`,
      group_tag: tag,
      metadata: { source: "pubmed", year: 2023 },
    });

    // Filter nested string property
    const { response, body } = await getJson(
      `/wiki?filter=group_tag:${tag},metadata.source:arxiv`,
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
      label: `${tag}-true`,
      group_tag: tag,
      processed: true,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-false`,
      group_tag: tag,
      processed: false,
    });

    // Using "properties.processed" should work the same as "processed"
    const { response, body } = await getJson(
      `/wiki?filter=group_tag:${tag},properties.processed:true`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);

    // Also test nested with prefix
    const e3 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-arxiv`,
      group_tag: tag,
      metadata: { source: "arxiv" },
    });
    const { body: body2 } = await getJson(
      `/wiki?filter=group_tag:${tag},properties.metadata.source:arxiv`,
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
      `/wiki?space_id=${space.id}`,
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
      label: `${tag}-active`,
      group_tag: tag,
      filter_status: "active",
    });
    const noMatch = await createEntity(actor.apiKey, "note", {
      label: `${tag}-archived`,
      group_tag: tag,
      filter_status: "archived",
    });

    await addEntityToSpace(actor.apiKey, space.id, match.id);
    await addEntityToSpace(actor.apiKey, space.id, noMatch.id);

    const { response, body } = await getJson(
      `/wiki?space_id=${space.id}&filter=filter_status:active`,
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
      `/wiki?filter=label:${tag}`,
      actor.apiKey,
    );
    expect(response.status).toBe(200);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(entity.id);
  });
});
