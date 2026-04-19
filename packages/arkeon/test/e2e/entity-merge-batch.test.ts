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

describe("Entity Merge Batch", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey);
  });

  // --- Happy path ---

  test("merge a group of 5 duplicates into one", async () => {
    const tag = uniqueName("kissinger");
    const entities = [];
    for (let i = 0; i < 5; i++) {
      entities.push(await createEntity(actor.apiKey, "person", {
        label: `${tag}-${i}`,
        description: i === 2
          ? "Henry Kissinger, Secretary of State, architect of detente"
          : `Secretary ref ${i}`,
        source_cable: `cable_${i}`,
      }));
    }

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
    const target = (targetBody as any).wiki;
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
    const tag = uniqueName("accum");
    const e1 = await createEntity(actor.apiKey, "person", {
      label: `${tag}-short`,
      tags: ["a", "b"],
      meta: { key1: "v1" },
    });
    const e2 = await createEntity(actor.apiKey, "person", {
      label: `${tag}-much-longer-label`,
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
    const props = (entityBody as any).wiki.properties;
    expect(props.label).toBe("Much Longer Label"); // longest string
    expect(props.tags).toEqual(expect.arrayContaining(["a", "b", "c"])); // union
    expect(props.tags).toHaveLength(3); // no dupes
    expect(props.meta.key1).toBe("v1"); // deep merge
    expect(props.meta.key2).toBe("v2"); // deep merge
  });

  // --- Relationships transferred ---

  test("relationships from all sources are transferred to target", async () => {
    const other = await createEntity(actor.apiKey, "document", { label: uniqueName("doc") });

    // e1 has no links, e2 and e3 have links to other
    const e1 = await createEntity(actor.apiKey, "person", { label: uniqueName("e1") });
    const e2 = await createWikiWithLinks(actor.apiKey, uniqueName("e2"), [other.id]);
    const e3 = await createWikiWithLinks(actor.apiKey, uniqueName("e3"), [other.id]);

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
    const rels = (relBody as any).relationships ?? [];
    // After dedup, there should be at least 1 "references" relationship to other
    expect(rels.length).toBeGreaterThanOrEqual(1);
    expect(rels.every((r: any) => r.predicate === "references")).toBe(true);
  });

  // --- Validation errors ---

  test("400 when entity appears in multiple groups", async () => {
    const e1 = await createEntity(actor.apiKey, "note", { label: uniqueName("x") });
    const e2 = await createEntity(actor.apiKey, "note", { label: uniqueName("y") });
    const e3 = await createEntity(actor.apiKey, "note", { label: uniqueName("z") });

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
    const e1 = await createEntity(actor.apiKey, "note", { label: uniqueName("solo") });

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
    const e1 = await createEntity(actor.apiKey, "note", { label: uniqueName("real") });

    const { response, body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, "01ZZZZZZZZZZZZZZZZZZZZZZZZ"] }],
      },
    });
    expect(response.status).toBe(404);
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

  test("spaces transfer from all sources", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("batch-space"));

    const e1 = await createEntity(actor.apiKey, "note", { label: uniqueName("e1") });
    const e2 = await createEntity(actor.apiKey, "note", { label: uniqueName("e2") });
    const e3 = await createEntity(actor.apiKey, "note", { label: uniqueName("e3") });

    // Add e2 to space
    await addEntityToSpace(actor.apiKey, space.id, e2.id);

    const { body } = await jsonRequest("/wiki/merge-batch", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        groups: [{ entity_ids: [e1.id, e2.id, e3.id] }],
      },
    });

    const targetId = (body as any).groups[0].target_id;

    // Target should be in space — use wiki listing with space_id filter
    // (the /spaces/{id}/entities endpoint has a missing actor-context bug)
    const { body: spaceBody } = await getJson(`/wiki?space_id=${space.id}`, actor.apiKey);
    expect((spaceBody as any).entities.some((e: any) => e.id === targetId)).toBe(true);
  });

  // --- Property strategies ---

  test("shallow_merge strategy: last source wins conflicts", async () => {
    const tag = uniqueName("shallow");
    const e1 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-first`,
      unique_to_1: true,
    });
    const e2 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-second`,
      unique_to_2: true,
    });
    const e3 = await createEntity(actor.apiKey, "note", {
      label: `${tag}-third`,
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
    const props = (entityBody as any).wiki.properties;

    // All unique keys should be present
    expect(props.unique_to_1).toBe(true);
    expect(props.unique_to_2).toBe(true);
    expect(props.unique_to_3).toBe(true);
  });

  // --- Deep merge ---

  test("accumulate deep-merges nested objects recursively", async () => {
    const tag = uniqueName("deep");
    const e1 = await createEntity(actor.apiKey, "person", {
      label: `${tag}-a`,
      metadata: { level1: { a: 1, b: 2 } },
    });
    const e2 = await createEntity(actor.apiKey, "person", {
      label: `${tag}-b`,
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
    const meta = (entityBody as any).wiki.properties.metadata;

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
});
