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

describe("Entity Merge", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey);
  });

  // --- Happy path ---

  test("merge transfers properties, relationships, and spaces", async () => {
    // Create target and source entities
    const target = await createEntity(actor.apiKey, "person", {
      label: uniqueName("merge-target"),
      name: "Target Name",
    });
    const source = await createEntity(actor.apiKey, "person", {
      label: uniqueName("merge-source"),
      name: "Source Name",
      extra_field: "from source",
    });

    // Create a third entity for relationships
    const other = await createEntity(actor.apiKey, "document", {
      label: uniqueName("merge-other"),
    });

    // Add relationships from source
    await createRelationship(actor.apiKey, source.id, "authored", other.id);

    // Add source to a space
    const space = await createSpace(actor.apiKey, uniqueName("merge-space"));
    await addEntityToSpace(actor.apiKey, space.id, source.id);

    // Merge source into target (default: keep_source)
    const { response, body } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        source_id: source.id,
        ver: target.ver,
        note: "Merged duplicate person",
      },
    });
    expect(response.status).toBe(200);
    const merged = (body as any).entity;
    expect(merged.id).toBe(target.id);
    expect(merged.ver).toBe(target.ver + 1);
    // keep_source: source properties replace target properties
    expect(merged.properties.extra_field).toBe("from source");

    // Verify relationships were repointed to target
    const { body: relBody } = await getJson(`/wiki/${target.id}/relationships`, actor.apiKey);
    const rels = (relBody as any).relationships;
    expect(rels.some((r: any) => r.predicate === "authored" && r.target_id === other.id)).toBe(true);

    // Verify target is now in the space
    const { body: spaceBody } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    const spaceEntities = (spaceBody as any).entities;
    expect(spaceEntities.some((e: any) => e.id === target.id)).toBe(true);

    // Verify source is gone
    const { response: sourceResp } = await apiRequest(`/wiki/${source.id}`, {
      apiKey: actor.apiKey,
    });
    expect(sourceResp.status).toBe(410);
  });

  // --- Property strategies ---

  test("property_strategy: keep_target preserves target properties", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: "target-label",
      target_only: true,
    });
    const source = await createEntity(actor.apiKey, "note", {
      label: "source-label",
      source_only: true,
    });

    const { response, body } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        source_id: source.id,
        property_strategy: "keep_target",
        ver: target.ver,
      },
    });
    expect(response.status).toBe(200);
    const merged = (body as any).entity;
    expect(merged.properties.label).toBe("target-label");
    expect(merged.properties.target_only).toBe(true);
    expect(merged.properties.source_only).toBeUndefined();
  });

  test("property_strategy: keep_source replaces with source properties", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: "target-label",
      target_only: true,
    });
    const source = await createEntity(actor.apiKey, "note", {
      label: "source-label",
      source_only: true,
    });

    const { response, body } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        source_id: source.id,
        property_strategy: "keep_source",
        ver: target.ver,
      },
    });
    expect(response.status).toBe(200);
    const merged = (body as any).entity;
    expect(merged.properties.label).toBe("source-label");
    expect(merged.properties.source_only).toBe(true);
    expect(merged.properties.target_only).toBeUndefined();
  });

  test("property_strategy: shallow_merge combines properties (source wins conflicts)", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: "target-label",
      target_only: "keep",
      shared: "from-target",
    });
    const source = await createEntity(actor.apiKey, "note", {
      label: "source-label",
      source_only: "keep",
      shared: "from-source",
    });

    const { response, body } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        source_id: source.id,
        property_strategy: "shallow_merge",
        ver: target.ver,
      },
    });
    expect(response.status).toBe(200);
    const merged = (body as any).entity;
    expect(merged.properties.target_only).toBe("keep");
    expect(merged.properties.source_only).toBe("keep");
    expect(merged.properties.shared).toBe("from-source"); // source wins
    expect(merged.properties.label).toBe("source-label"); // source wins
  });

  // --- Validation errors ---

  test("400 when merging entity into itself", async () => {
    const entity = await createEntity(actor.apiKey, "note", { label: "self" });

    const { response, body } = await jsonRequest(`/wiki/${entity.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: entity.id, ver: entity.ver },
    });
    expect(response.status).toBe(400);
  });

  test("400 when merging entities of different kinds", async () => {
    const entity = await createEntity(actor.apiKey, "note", { label: "e" });
    const entity2 = await createEntity(actor.apiKey, "note", { label: "e2" });
    // Create a relationship (which is kind='relationship')
    const rel = await createRelationship(actor.apiKey, entity.id, "cites", entity2.id);
    const relId = rel.relationship.id;

    // Try to merge relationship into entity
    const { response } = await jsonRequest(`/wiki/${entity.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: relId, ver: entity.ver },
    });
    expect(response.status).toBe(400);
  });

  test("409 on CAS version mismatch", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: "t" });
    const source = await createEntity(actor.apiKey, "note", { label: "s" });

    const { response, body } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver + 999 },
    });
    expect(response.status).toBe(409);
    expect((body as any).error.code).toBe("cas_conflict");
  });

  // --- Relationship merge ---

  test("merge two relationships with same endpoints", async () => {
    const entityA = await createEntity(actor.apiKey, "note", { label: uniqueName("a") });
    const entityB = await createEntity(actor.apiKey, "note", { label: uniqueName("b") });

    const rel1 = await createRelationship(actor.apiKey, entityA.id, "references", entityB.id, {
      weight: 1,
      note: "first",
    });
    const rel2 = await createRelationship(actor.apiKey, entityA.id, "cites", entityB.id, {
      weight: 5,
      note: "second",
    });

    const targetRelId = rel1.relationship.id;
    const sourceRelId = rel2.relationship.id;
    const targetRelVer = rel1.relationship.ver;

    const { response, body } = await jsonRequest(`/wiki/${targetRelId}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        source_id: sourceRelId,
        property_strategy: "keep_source",
        ver: targetRelVer,
      },
    });
    expect(response.status).toBe(200);
    const merged = (body as any).entity;
    // Relationship properties may be double-string-encoded; unwrap as needed
    let props = merged.properties;
    while (typeof props === "string") {
      props = JSON.parse(props);
    }
    expect(props.weight).toBe(5);
    expect(props.note).toBe("second");

    // Source relationship should be gone
    const { response: srcResp } = await apiRequest(`/relationships/${sourceRelId}`, {
      apiKey: actor.apiKey,
    });
    expect(srcResp.status).toBe(404);
  });

  test("400 when merging relationships with different endpoints", async () => {
    const entityA = await createEntity(actor.apiKey, "note", { label: "a" });
    const entityB = await createEntity(actor.apiKey, "note", { label: "b" });
    const entityC = await createEntity(actor.apiKey, "note", { label: "c" });

    const rel1 = await createRelationship(actor.apiKey, entityA.id, "references", entityB.id);
    const rel2 = await createRelationship(actor.apiKey, entityA.id, "references", entityC.id);

    const { response, body } = await jsonRequest(`/wiki/${rel1.relationship.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        source_id: rel2.relationship.id,
        ver: rel1.relationship.ver,
      },
    });
    expect(response.status).toBe(400);
    expect((body as any).error.message).toContain("different endpoints");
  });

  // --- Edge deduplication ---

  test("duplicate edges are deduplicated during merge", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: "t" });
    const source = await createEntity(actor.apiKey, "note", { label: "s" });
    const other = await createEntity(actor.apiKey, "note", { label: "o" });

    // Both have "cites" relationship to other
    await createRelationship(actor.apiKey, target.id, "cites", other.id);
    await createRelationship(actor.apiKey, source.id, "cites", other.id);

    // Also a unique relationship only from source
    await createRelationship(actor.apiKey, source.id, "authored", other.id);

    const { response } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver },
    });
    expect(response.status).toBe(200);

    // Target should have exactly 2 outgoing relationships: cites and authored
    const { body: relBody } = await getJson(`/wiki/${target.id}/relationships?direction=out`, actor.apiKey);
    const rels = (relBody as any).relationships ?? [];
    const predicates = rels.map((r: any) => r.predicate).sort();
    expect(predicates).toEqual(["authored", "cites"]);
  });

  // --- Self-referential edge deletion ---

  test("self-referential edges between source and target are deleted", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: "t" });
    const source = await createEntity(actor.apiKey, "note", { label: "s" });

    // Create relationship from source to target
    await createRelationship(actor.apiKey, source.id, "relates_to", target.id);

    const { response } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver },
    });
    expect(response.status).toBe(200);

    // Target should have no self-referencing relationships
    const { body: relBody } = await getJson(`/wiki/${target.id}/relationships`, actor.apiKey);
    const rels = (relBody as any).relationships;
    const selfRefs = rels.filter((r: any) => r.source_id === target.id && r.target_id === target.id);
    expect(selfRefs.length).toBe(0);
  });

  // --- Redirect on GET ---

  test("GET on merged entity returns 410 with merged_into", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: "t" });
    const source = await createEntity(actor.apiKey, "note", { label: "s" });

    await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver },
    });

    const { response, body } = await apiRequest(`/wiki/${source.id}`, {
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(410);
    expect((body as any).error.code).toBe("entity_merged");
    expect((body as any).error.details.merged_into).toBe(target.id);
  });

  // --- Additional edge case tests ---

  test("404 when source entity does not exist", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });

    const { response, body } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", ver: target.ver },
    });
    expect(response.status).toBe(404);
  });

  test("404 when target entity does not exist", async () => {
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });

    const { response } = await jsonRequest("/wiki/01ZZZZZZZZZZZZZZZZZZZZZZZZ/merge", {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: 1 },
    });
    expect(response.status).toBe(404);
  });

  test("redirect chain: A→B then B→C results in A→C", async () => {
    const entityA = await createEntity(actor.apiKey, "note", { label: uniqueName("a") });
    const entityB = await createEntity(actor.apiKey, "note", { label: uniqueName("b") });
    const entityC = await createEntity(actor.apiKey, "note", { label: uniqueName("c") });

    // Merge A into B
    await jsonRequest(`/wiki/${entityB.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: entityA.id, ver: entityB.ver },
    });

    // Merge B into C (B's ver is now 2 after absorbing A)
    await jsonRequest(`/wiki/${entityC.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: entityB.id, ver: entityC.ver },
    });

    // A's redirect should now point directly to C (chain resolved)
    const { response, body } = await apiRequest(`/wiki/${entityA.id}`, {
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(410);
    expect((body as any).error.details.merged_into).toBe(entityC.id);

    // B's redirect should also point to C
    const { response: respB, body: bodyB } = await apiRequest(`/wiki/${entityB.id}`, {
      apiKey: actor.apiKey,
    });
    expect(respB.status).toBe(410);
    expect((bodyB as any).error.details.merged_into).toBe(entityC.id);
  });

  test("third-party relationships are repointed during merge", async () => {
    // ActorB creates entities and a relationship
    const actorB = await createActor(adminApiKey);
    const thirdParty = await createEntity(actorB.apiKey, "note", { label: uniqueName("tp") });

    // Actor creates source and target
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });

    // ActorB creates a relationship from thirdParty to source (actor doesn't own this rel)
    await createRelationship(actorB.apiKey, thirdParty.id, "references", source.id);

    // Actor merges source into target
    const { response } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver },
    });
    expect(response.status).toBe(200);

    // The third-party relationship should now point to target
    const { body: relBody } = await getJson(`/wiki/${thirdParty.id}/relationships?direction=out`, actorB.apiKey);
    const rels = (relBody as any).relationships ?? [];
    expect(rels.some((r: any) => r.predicate === "references" && r.target_id === target.id)).toBe(true);
    expect(rels.some((r: any) => r.target_id === source.id)).toBe(false);
  });

  test("spaces actor does not own are transferred during merge", async () => {
    // ActorB creates a space
    const actorB = await createActor(adminApiKey);
    const space = await createSpace(actorB.apiKey, uniqueName("space"));

    // Actor creates source and target
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });

    // ActorB adds source to their space (actor has no role in this space)
    await addEntityToSpace(actorB.apiKey, space.id, source.id);

    // Actor merges source into target
    const { response } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver },
    });
    expect(response.status).toBe(200);

    // Target should now be in actorB's space (SECURITY DEFINER bypasses space RLS)
    const { body: spaceBody } = await getJson(`/spaces/${space.id}/entities`, actorB.apiKey);
    const spaceEntities = (spaceBody as any).entities ?? [];
    expect(spaceEntities.some((e: any) => e.id === target.id)).toBe(true);
  });

  test("multiple incoming relationships from different entities are all repointed", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });
    const other1 = await createEntity(actor.apiKey, "note", { label: uniqueName("o1") });
    const other2 = await createEntity(actor.apiKey, "note", { label: uniqueName("o2") });
    const other3 = await createEntity(actor.apiKey, "note", { label: uniqueName("o3") });

    // Create incoming relationships to source from multiple entities
    await createRelationship(actor.apiKey, other1.id, "cites", source.id);
    await createRelationship(actor.apiKey, other2.id, "references", source.id);
    await createRelationship(actor.apiKey, other3.id, "authored", source.id);

    const { response } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver },
    });
    expect(response.status).toBe(200);

    // All incoming relationships should now point to target
    const { body: relBody } = await getJson(`/wiki/${target.id}/relationships?direction=in`, actor.apiKey);
    const rels = (relBody as any).relationships ?? [];
    expect(rels.length).toBe(3);
    const predicates = rels.map((r: any) => r.predicate).sort();
    expect(predicates).toEqual(["authored", "cites", "references"]);
  });
});
