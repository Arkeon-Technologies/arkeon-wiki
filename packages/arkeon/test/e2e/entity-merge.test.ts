// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  addEntityToSpace,
  apiRequest,
  createActor,
  createEntity,
  createWikiWithLinks,
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

    // Create a third entity for relationships
    const other = await createEntity(actor.apiKey, "document", {
      label: uniqueName("merge-other"),
    });

    // Create source with a link to other (creates a "references" relationship)
    const source = await createWikiWithLinks(
      actor.apiKey,
      uniqueName("merge-source"),
      [other.id],
      { type: "person", properties: { name: "Source Name", extra_field: "from source" } },
    );

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
    const merged = (body as any).wiki;
    expect(merged.id).toBe(target.id);
    expect(merged.ver).toBe(target.ver + 1);
    // keep_source: source properties replace target properties
    expect(merged.properties.extra_field).toBe("from source");

    // Verify relationships were repointed to target
    const { body: relBody } = await getJson(`/wiki/${target.id}/relationships`, actor.apiKey);
    const rels = (relBody as any).relationships;
    expect(rels.some((r: any) => r.predicate === "references" && r.target_id === other.id)).toBe(true);

    // Verify source is gone
    const { response: sourceResp } = await apiRequest(`/wiki/${source.id}`, {
      apiKey: actor.apiKey,
    });
    expect(sourceResp.status).toBe(410);
  });

  // --- Property strategies ---

  test("property_strategy: keep_target preserves target properties", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: uniqueName("target-label"),
      target_only: true,
    });
    const source = await createEntity(actor.apiKey, "note", {
      label: uniqueName("source-label"),
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
    const merged = (body as any).wiki;
    expect(merged.properties.label).toContain("target-label");
    expect(merged.properties.target_only).toBe(true);
    expect(merged.properties.source_only).toBeUndefined();
  });

  test("property_strategy: keep_source replaces with source properties", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: uniqueName("target-label"),
      target_only: true,
    });
    const source = await createEntity(actor.apiKey, "note", {
      label: uniqueName("source-label"),
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
    const merged = (body as any).wiki;
    expect(merged.properties.label).toContain("source-label");
    expect(merged.properties.source_only).toBe(true);
    expect(merged.properties.target_only).toBeUndefined();
  });

  test("property_strategy: shallow_merge combines properties (source wins conflicts)", async () => {
    const target = await createEntity(actor.apiKey, "note", {
      label: uniqueName("target-label"),
      target_only: "keep",
      shared: "from-target",
    });
    const source = await createEntity(actor.apiKey, "note", {
      label: uniqueName("source-label"),
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
    const merged = (body as any).wiki;
    expect(merged.properties.target_only).toBe("keep");
    expect(merged.properties.source_only).toBe("keep");
    expect(merged.properties.shared).toBe("from-source"); // source wins
    expect(merged.properties.label).toContain("source-label"); // source wins
  });

  // --- Validation errors ---

  test("400 when merging entity into itself", async () => {
    const entity = await createEntity(actor.apiKey, "note", { label: uniqueName("self") });

    const { response, body } = await jsonRequest(`/wiki/${entity.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: entity.id, ver: entity.ver },
    });
    expect(response.status).toBe(400);
  });

  test("409 on CAS version mismatch", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });

    const { response, body } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver + 999 },
    });
    expect(response.status).toBe(409);
    expect((body as any).error.code).toBe("cas_conflict");
  });

  // --- Edge deduplication ---

  test("duplicate edges are deduplicated during merge", async () => {
    const other = await createEntity(actor.apiKey, "note", { label: uniqueName("o") });

    // Both target and source have "references" relationship to other (via wiki links)
    const target = await createWikiWithLinks(
      actor.apiKey,
      uniqueName("t"),
      [other.id],
    );
    const source = await createWikiWithLinks(
      actor.apiKey,
      uniqueName("s"),
      [other.id],
    );

    const { response } = await jsonRequest(`/wiki/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: { source_id: source.id, ver: target.ver },
    });
    expect(response.status).toBe(200);

    // Target should have exactly 1 outgoing relationship (deduped "references" to other)
    const { body: relBody } = await getJson(`/wiki/${target.id}/relationships?direction=out`, actor.apiKey);
    const rels = (relBody as any).relationships ?? [];
    expect(rels.length).toBe(1);
    expect(rels[0].predicate).toBe("references");
    expect(rels[0].target_id).toBe(other.id);
  });

  // --- Self-referential edge deletion ---

  test("self-referential edges between source and target are deleted", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });

    // Create source with a link to target (creates relationship source→target)
    const source = await createWikiWithLinks(
      actor.apiKey,
      uniqueName("s"),
      [target.id],
    );

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
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });

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
    // ActorB creates a wiki with a link to source
    const actorB = await createActor(adminApiKey);

    // Actor creates source and target
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });

    // ActorB creates a wiki with a link to source (creates a "references" relationship)
    const thirdParty = await createWikiWithLinks(
      actorB.apiKey,
      uniqueName("tp"),
      [source.id],
    );

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

    // Verify the merge completed. The target should be in actorB's space,
    // but the list-space-entities endpoint has a missing actor-context bug
    // so we verify via the entity listing filtered by space_id instead.
    const { body: listBody } = await getJson(
      `/wiki?space_id=${space.id}`,
      actorB.apiKey,
    );
    const entityIds = ((listBody as any).entities ?? []).map((e: any) => e.id);
    expect(entityIds).toContain(target.id);
  });

  test("multiple incoming relationships from different entities are all repointed", async () => {
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("t") });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("s") });

    // Create wikis with links to source (creates incoming "references" relationships)
    const other1 = await createWikiWithLinks(actor.apiKey, uniqueName("o1"), [source.id]);
    const other2 = await createWikiWithLinks(actor.apiKey, uniqueName("o2"), [source.id]);
    const other3 = await createWikiWithLinks(actor.apiKey, uniqueName("o3"), [source.id]);

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
    // All relationships are "references" from the wiki pipeline
    for (const rel of rels) {
      expect(rel.predicate).toBe("references");
      expect(rel.target_id).toBe(target.id);
    }
  });
});
