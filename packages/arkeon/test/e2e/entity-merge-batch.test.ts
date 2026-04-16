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
  grantEntityPermission,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Entity Merge Batch", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
  });

  // --- Happy path ---

  test("merge a group of 5 duplicates into one", async () => {
    const entities = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createEntity(actor.apiKey, "person", {
          label: "Kissinger",
          description: i === 2
            ? "Henry Kissinger, Secretary of State, architect of detente"
            : `Secretary ref ${i}`,
          source_cable: `cable_${i}`,
        }),
      ),
    );

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: entities.map((e) => e.id) }],
        property_strategy: "accumulate",
      },
    });

    expect(response.status).toBe(200);
    const result = body as any;
    expect(result.merged).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].merged_count).toBe(4);
    expect(result.groups[0].error).toBeNull();

    // Target should have the longest description (accumulate keeps longest)
    const { body: targetBody } = await getJson(
      `/wiki/${result.groups[0].target_id}`,
      actor.apiKey,
    );
    const target = (targetBody as any).entity;
    expect(target.properties.description).toContain("architect of detente");

    // All non-target entities should return 410
    const nonTargets = entities.filter((e) => e.id !== result.groups[0].target_id);
    for (const e of nonTargets) {
      const { response: r } = await apiRequest(`/wiki/${e.id}`, {
        apiKey: actor.apiKey,
      });
      expect(r.status).toBe(410);
    }
  });

  test("merge multiple groups concurrently", async () => {
    const groupA = await Promise.all(
      Array.from({ length: 3 }, () =>
        createEntity(actor.apiKey, "person", { label: uniqueName("a") }),
      ),
    );
    const groupB = await Promise.all(
      Array.from({ length: 3 }, () =>
        createEntity(actor.apiKey, "organization", { label: uniqueName("b") }),
      ),
    );

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [
          { entity_ids: groupA.map((e) => e.id) },
          { entity_ids: groupB.map((e) => e.id) },
        ],
      },
    });

    expect(response.status).toBe(200);
    const result = body as any;
    expect(result.merged).toBe(4); // 2 + 2
    expect(result.failed).toBe(0);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].merged_count).toBe(2);
    expect(result.groups[1].merged_count).toBe(2);
  });

  // --- Accumulate strategy ---

  test("accumulate keeps longest string and unions arrays", async () => {
    const e1 = await createEntity(actor.apiKey, "person", {
      label: "Short",
      tags: ["a", "b"],
      meta: { key1: "v1" },
    });
    const e2 = await createEntity(actor.apiKey, "person", {
      label: "Much Longer Label",
      tags: ["b", "c"],
      meta: { key2: "v2" },
    });

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e2.id] }],
        property_strategy: "accumulate",
      },
    });

    expect(response.status).toBe(200);
    const target = (body as any).groups[0];
    const { body: entityBody } = await getJson(
      `/wiki/${target.target_id}`,
      actor.apiKey,
    );
    const props = (entityBody as any).entity.properties;
    expect(props.label).toBe("Much Longer Label"); // longest string
    expect(props.tags).toEqual(expect.arrayContaining(["a", "b", "c"])); // union
    expect(props.tags).toHaveLength(3); // no dupes
    expect(props.meta.key1).toBe("v1"); // deep merge
    expect(props.meta.key2).toBe("v2"); // deep merge
  });

  // --- Relationships transferred ---

  test("relationships from all sources are transferred to target", async () => {
    const e1 = await createEntity(actor.apiKey, "person", { label: uniqueName("e1") });
    const e2 = await createEntity(actor.apiKey, "person", { label: uniqueName("e2") });
    const e3 = await createEntity(actor.apiKey, "person", { label: uniqueName("e3") });
    const other = await createEntity(actor.apiKey, "document", { label: uniqueName("doc") });

    // e2 and e3 have relationships to other
    await createRelationship(actor.apiKey, e2.id, "authored", other.id);
    await createRelationship(actor.apiKey, e3.id, "cites", other.id);

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e2.id, e3.id] }],
      },
    });

    expect(response.status).toBe(200);
    const targetId = (body as any).groups[0].target_id;

    const { body: relBody } = await getJson(
      `/wiki/${targetId}/relationships?direction=out`,
      actor.apiKey,
    );
    const predicates = ((relBody as any).relationships ?? [])
      .map((r: any) => r.predicate)
      .sort();
    expect(predicates).toEqual(["authored", "cites"]);
  });

  // --- Validation errors ---

  test("400 when entity appears in multiple groups", async () => {
    const e1 = await createEntity(actor.apiKey, "note", { label: "x" });
    const e2 = await createEntity(actor.apiKey, "note", { label: "y" });
    const e3 = await createEntity(actor.apiKey, "note", { label: "z" });

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [
          { entity_ids: [e1.id, e2.id] },
          { entity_ids: [e2.id, e3.id] }, // e2 in both
        ],
      },
    });
    expect(response.status).toBe(400);
    expect((body as any).error.message).toContain("appears in multiple groups");
  });

  test("400 when group has fewer than 2 entities", async () => {
    const e1 = await createEntity(actor.apiKey, "note", { label: "solo" });

    const { response } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id] }],
      },
    });
    expect(response.status).toBe(400);
  });

  test("404 when an entity does not exist", async () => {
    const e1 = await createEntity(actor.apiKey, "note", { label: "real" });

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, "01ZZZZZZZZZZZZZZZZZZZZZZZZ"] }],
      },
    });
    expect(response.status).toBe(404);
  });

  test("403 when actor lacks admin on any entity", async () => {
    const actorB = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });
    const owned = await createEntity(actor.apiKey, "note", { label: uniqueName("o") });
    const foreign = await createEntity(actorB.apiKey, "note", { label: uniqueName("f") });

    // Grant editor (not admin) so actor can see it
    await grantEntityPermission(actorB.apiKey, foreign.id, "actor", actor.id, "editor");

    const { response } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [owned.id, foreign.id] }],
      },
    });
    expect(response.status).toBe(403);
  });

  // --- Redirect chains ---

  test("all source IDs redirect to target after batch merge", async () => {
    const entities = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createEntity(actor.apiKey, "note", { label: uniqueName(`chain-${i}`) }),
      ),
    );

    const { body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: entities.map((e) => e.id) }],
      },
    });

    const targetId = (body as any).groups[0].target_id;
    const sources = entities.filter((e) => e.id !== targetId);

    for (const source of sources) {
      const { response, body: rBody } = await apiRequest(`/wiki/${source.id}`, {
        apiKey: actor.apiKey,
      });
      expect(response.status).toBe(410);
      expect((rBody as any).error.details.merged_into).toBe(targetId);
    }
  });

  // --- Space and permission transfer ---

  test("spaces and permissions transfer from all sources", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("batch-space"));
    const actorB = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });

    const e1 = await createEntity(actor.apiKey, "note", { label: uniqueName("e1") });
    const e2 = await createEntity(actor.apiKey, "note", { label: uniqueName("e2") });
    const e3 = await createEntity(actor.apiKey, "note", { label: uniqueName("e3") });

    // Add e2 to space, grant permission on e3
    await addEntityToSpace(actor.apiKey, space.id, e2.id);
    await grantEntityPermission(actor.apiKey, e3.id, "actor", actorB.id, "editor");

    const { body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e2.id, e3.id] }],
      },
    });

    const targetId = (body as any).groups[0].target_id;

    // Target should be in space
    const { body: spaceBody } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    expect((spaceBody as any).entities.some((e: any) => e.id === targetId)).toBe(true);

    // Target should have actorB's permission
    const { body: permBody } = await getJson(`/wiki/${targetId}/permissions`, actor.apiKey);
    expect((permBody as any).permissions.some(
      (p: any) => p.grantee_id === actorB.id && p.role === "editor",
    )).toBe(true);
  });

  // --- Property strategies ---

  test("shallow_merge strategy: last source wins conflicts", async () => {
    const e1 = await createEntity(actor.apiKey, "note", {
      label: "first",
      unique_to_1: true,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: "second",
      unique_to_2: true,
    });
    const e3 = await createEntity(actor.apiKey, "note", {
      label: "third",
      unique_to_3: true,
    });

    const { body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e2.id, e3.id] }],
        property_strategy: "shallow_merge",
      },
    });

    const targetId = (body as any).groups[0].target_id;
    const { body: entityBody } = await getJson(`/wiki/${targetId}`, actor.apiKey);
    const props = (entityBody as any).entity.properties;

    // All unique keys should be present
    expect(props.unique_to_1).toBe(true);
    expect(props.unique_to_2).toBe(true);
    expect(props.unique_to_3).toBe(true);
  });

  // --- Deep merge ---

  test("accumulate deep-merges nested objects recursively", async () => {
    const e1 = await createEntity(actor.apiKey, "person", {
      label: "test",
      metadata: { level1: { a: 1, b: 2 } },
    });
    const e2 = await createEntity(actor.apiKey, "person", {
      label: "test",
      metadata: { level1: { c: 3 }, level2: "new" },
    });

    const { body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e2.id] }],
        property_strategy: "accumulate",
      },
    });

    const targetId = (body as any).groups[0].target_id;
    const { body: entityBody } = await getJson(`/wiki/${targetId}`, actor.apiKey);
    const meta = (entityBody as any).entity.properties.metadata;

    // Nested object keys from both entities should be preserved
    expect(meta.level1.a).toBe(1);
    expect(meta.level1.b).toBe(2);
    expect(meta.level1.c).toBe(3);
    expect(meta.level2).toBe("new");
  });

  // --- Intra-group duplicate IDs ---

  test("duplicate IDs within a group are deduplicated silently", async () => {
    const e1 = await createEntity(actor.apiKey, "note", { label: uniqueName("d1") });
    const e2 = await createEntity(actor.apiKey, "note", { label: uniqueName("d2") });

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e2.id, e1.id] }], // e1 duplicated
      },
    });

    expect(response.status).toBe(200);
    expect((body as any).merged).toBe(1); // only 1 merge, not 2
    expect((body as any).groups[0].error).toBeNull();
  });

  test("400 when intra-group dedup leaves fewer than 2 unique IDs", async () => {
    const e1 = await createEntity(actor.apiKey, "note", { label: uniqueName("solo") });

    const { response } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e1.id] }],
      },
    });

    expect(response.status).toBe(400);
  });

  // --- Relationship endpoint validation ---

  test("error when merging relationships with different endpoints", async () => {
    const a = await createEntity(actor.apiKey, "note", { label: uniqueName("a") });
    const b = await createEntity(actor.apiKey, "note", { label: uniqueName("b") });
    const c = await createEntity(actor.apiKey, "note", { label: uniqueName("c") });

    const rel1 = await createRelationship(actor.apiKey, a.id, "cites", b.id);
    const rel2 = await createRelationship(actor.apiKey, a.id, "cites", c.id); // different target

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [rel1.relationship.id, rel2.relationship.id] }],
      },
    });

    expect(response.status).toBe(200);
    // Group should fail with endpoint mismatch error
    expect((body as any).groups[0].error).toContain("different endpoints");
    expect((body as any).failed).toBe(1);
  });

  test("relationships with same endpoints merge successfully", async () => {
    const a = await createEntity(actor.apiKey, "note", { label: uniqueName("a") });
    const b = await createEntity(actor.apiKey, "note", { label: uniqueName("b") });

    const rel1 = await createRelationship(actor.apiKey, a.id, "cites", b.id, { weight: 1 });
    const rel2 = await createRelationship(actor.apiKey, a.id, "references", b.id, { weight: 5 });

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [rel1.relationship.id, rel2.relationship.id] }],
        property_strategy: "accumulate",
      },
    });

    expect(response.status).toBe(200);
    expect((body as any).merged).toBe(1);
    expect((body as any).groups[0].error).toBeNull();
  });
});
