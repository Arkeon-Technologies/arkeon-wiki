// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  createActor,
  createEntity,
  createSpace,
  getJson,
  grantEntityPermission,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Classification model", () => {
  let level2Actor: Awaited<ReturnType<typeof createActor>>;
  let level4Actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actors", async () => {
    level2Actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
      canPublishPublic: true,
    });
    level4Actor = await createActor(adminApiKey, {
      maxReadLevel: 4,
      maxWriteLevel: 4,
      canPublishPublic: true,
    });
  });

  test("Actor at level 2 can read entities at level 0, 1, 2", async () => {
    for (const level of [0, 1, 2]) {
      const entity = await createEntity(
        level4Actor.apiKey,
        "note",
        { label: uniqueName(`read-l${level}`) },
        { read_level: level, write_level: level },
      );
      const { response } = await getJson(`/wiki/${entity.id}`, level2Actor.apiKey);
      expect(response.status).toBe(200);
    }
  });

  test("Actor at level 2 cannot read entities at level 3, 4 (gets 404)", async () => {
    for (const level of [3, 4]) {
      const entity = await createEntity(
        level4Actor.apiKey,
        "note",
        { label: uniqueName(`hidden-l${level}`) },
        { read_level: level, write_level: level },
      );
      const { response } = await getJson(`/wiki/${entity.id}`, level2Actor.apiKey);
      expect(response.status).toBe(404);
    }
  });

  test("Actor at level 2 can create entities at level 0, 1, 2", async () => {
    for (const level of [0, 1, 2]) {
      const entity = await createEntity(
        level2Actor.apiKey,
        "note",
        { label: uniqueName(`create-l${level}`) },
        { read_level: level, write_level: level },
      );
      expect(entity.id).toBeTruthy();
    }
  });

  test("Actor at level 2 cannot create entities at level 3", async () => {
    const { response } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: level2Actor.apiKey,
      json: {
        type: "note",
        properties: { label: uniqueName("too-high") },
        read_level: 3,
        write_level: 3,
      },
    });
    expect([403, 500]).toContain(response.status);
  });

  test("PUBLIC (read_level=0) entities are visible without authentication", async () => {
    const entity = await createEntity(
      level2Actor.apiKey,
      "note",
      { label: uniqueName("public") },
      { read_level: 0, write_level: 0 },
    );
    // No apiKey -- unauthenticated
    const { response, body } = await getJson(`/wiki/${entity.id}`);
    expect(response.status).toBe(200);
    expect((body as any).entity.id).toBe(entity.id);
  });

  test("Unauthenticated request cannot see INTERNAL (read_level=1) entities", async () => {
    const entity = await createEntity(
      level2Actor.apiKey,
      "note",
      { label: uniqueName("internal") },
      { read_level: 1, write_level: 1 },
    );
    const { response } = await getJson(`/wiki/${entity.id}`);
    expect(response.status).toBe(404);
  });

  test("Owner can edit their own entity", async () => {
    const entity = await createEntity(
      level2Actor.apiKey,
      "note",
      { label: "before" },
      { read_level: 1, write_level: 1 },
    );
    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: level2Actor.apiKey,
      json: { ver: entity.ver, properties: { label: "after" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.properties.label).toBe("after");
  });

  test("Non-owner at same level cannot edit (gets 403)", async () => {
    const owner = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const other = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: "owned" },
      { read_level: 1, write_level: 1 },
    );
    const { response } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: other.apiKey,
      json: { ver: entity.ver, properties: { label: "hacked" } },
    });
    expect(response.status).toBe(403);
  });

  test("Actor with editor grant CAN edit", async () => {
    const owner = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const editor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: "to-edit" },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "actor", editor.id, "editor");

    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: editor.apiKey,
      json: { ver: entity.ver, properties: { label: "edited" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.properties.label).toBe("edited");
  });

  test("Admin (is_admin=true) can edit any entity", async () => {
    const entity = await createEntity(
      level2Actor.apiKey,
      "note",
      { label: "admin-target" },
      { read_level: 1, write_level: 1 },
    );
    // Use the admin key directly
    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: adminApiKey,
      json: { ver: entity.ver, properties: { label: "admin-edited" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.properties.label).toBe("admin-edited");
  });

  test("Actor cannot write to entity above their write_level", async () => {
    // level4 creates a write_level=3 entity
    const entity = await createEntity(
      level4Actor.apiKey,
      "note",
      { label: "high-write" },
      { read_level: 1, write_level: 3 },
    );
    // level2 actor tries to update -- should fail even with editor grant
    // (because RLS checks write_level ceiling)
    const { response } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: level2Actor.apiKey,
      json: { ver: entity.ver, properties: { label: "nope" } },
    });
    expect([403, 404]).toContain(response.status);
  });

  test("Spaces with read_level=2 are invisible to level-1 actor", async () => {
    const level1Actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });
    const space = await createSpace(level4Actor.apiKey, uniqueName("secret-space"), {
      read_level: 2,
    });

    const { response } = await getJson(`/spaces/${space.id}`, level1Actor.apiKey);
    expect(response.status).toBe(404); // invisible, not forbidden
  });

  // --- Relationship classification (#6) ---

  test("Relationship inherits max(source, target) classification by default", async () => {
    const src = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-src-l1") }, { read_level: 1, write_level: 1 });
    const tgt = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-tgt-l2") }, { read_level: 2, write_level: 2 });

    const { response, body } = await jsonRequest(`/wiki/${src.id}/relationships`, {
      method: "POST",
      apiKey: level4Actor.apiKey,
      json: { predicate: "references", target_id: tgt.id },
    });
    expect(response.status).toBe(201);
    const rel = (body as any).relationship;
    expect(rel.read_level).toBe(2);
    expect(rel.write_level).toBe(2);
  });

  test("Relationship read_level can be set above the endpoint floor", async () => {
    const src = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-src-up") }, { read_level: 1, write_level: 1 });
    const tgt = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-tgt-up") }, { read_level: 1, write_level: 1 });

    const { response, body } = await jsonRequest(`/wiki/${src.id}/relationships`, {
      method: "POST",
      apiKey: level4Actor.apiKey,
      json: { predicate: "references", target_id: tgt.id, read_level: 3, write_level: 3 },
    });
    expect(response.status).toBe(201);
    const rel = (body as any).relationship;
    expect(rel.read_level).toBe(3);
    expect(rel.write_level).toBe(3);
  });

  test("Relationship read_level below endpoint floor is rejected with 400", async () => {
    const src = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-src-lo") }, { read_level: 2, write_level: 2 });
    const tgt = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-tgt-lo") }, { read_level: 3, write_level: 1 });

    const { response, body } = await jsonRequest(`/wiki/${src.id}/relationships`, {
      method: "POST",
      apiKey: level4Actor.apiKey,
      json: { predicate: "references", target_id: tgt.id, read_level: 1 },
    });
    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("invalid_read_level");
  });

  test("Relationship write_level below endpoint floor is rejected with 400", async () => {
    const src = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-src-wlo") }, { read_level: 1, write_level: 3 });
    const tgt = await createEntity(level4Actor.apiKey, "note",
      { label: uniqueName("rel-tgt-wlo") }, { read_level: 1, write_level: 1 });

    const { response, body } = await jsonRequest(`/wiki/${src.id}/relationships`, {
      method: "POST",
      apiKey: level4Actor.apiKey,
      json: { predicate: "references", target_id: tgt.id, write_level: 1 },
    });
    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("invalid_write_level");
  });
});
