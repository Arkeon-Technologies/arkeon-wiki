// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  adminApiKey,
  createActor,
  createEntity,
  createSpace,
  getJson,
  grantSpacePermission,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Inline space_id and permissions on entity/relationship creation", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
  });

  // --- Entity + space_id ---

  test("Create entity with space_id adds entity to space atomically", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("inline-space"));
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("inline-entity"),
    }, { space_id: space.id });

    // Verify entity exists in space
    const { body } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(entity.id);
  });

  test("Create entity with space_id updates space entity_count", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("count-space"));

    await createEntity(actor.apiKey, "note", {
      label: uniqueName("count-1"),
    }, { space_id: space.id });

    await createEntity(actor.apiKey, "note", {
      label: uniqueName("count-2"),
    }, { space_id: space.id });

    const { body } = await getJson(`/spaces/${space.id}`, actor.apiKey);
    expect((body as any).space.entity_count).toBe(2);
  });

  test("Create entity with invalid space_id returns 404, no orphaned entity", async () => {
    const { response } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        type: "note",
        properties: { label: uniqueName("orphan-test") },
        space_id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    expect(response.status).toBe(404);
  });

  test("Create entity with space_id but no contributor role returns 403", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("no-role-space"));
    const outsider = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });

    const { response } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: outsider.apiKey,
      json: {
        type: "note",
        properties: { label: uniqueName("no-role-entity") },
        space_id: space.id,
      },
    });
    expect(response.status).toBe(403);
  });

  test("Create entity with space_id works for contributor", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("contributor-space"));
    const contributor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    await grantSpacePermission(actor.apiKey, space.id, "actor", contributor.id, "contributor");

    const entity = await createEntity(contributor.apiKey, "note", {
      label: uniqueName("contributor-entity"),
    }, { space_id: space.id });

    const { body } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    const ids = (body as any).entities.map((e: any) => e.id);
    expect(ids).toContain(entity.id);
  });

  // --- Entity + permissions ---

  test("Create entity with inline permissions grants them atomically", async () => {
    const grantee = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });

    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("perm-entity"),
    }, {
      permissions: [
        { grantee_type: "actor", grantee_id: grantee.id, role: "editor" },
      ],
    });

    // Verify grantee can edit the entity
    const { response } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: grantee.apiKey,
      json: { ver: 1, properties: { label: "edited-by-grantee" } },
    });
    expect(response.status).toBe(200);
  });

  test("Create entity with multiple permission grants", async () => {
    const grantee1 = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });
    const grantee2 = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });

    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("multi-perm"),
    }, {
      permissions: [
        { grantee_type: "actor", grantee_id: grantee1.id, role: "editor" },
        { grantee_type: "actor", grantee_id: grantee2.id, role: "admin" },
      ],
    });

    // Verify permissions via GET
    const { body } = await getJson(`/wiki/${entity.id}/permissions`, actor.apiKey);
    const perms = (body as any).permissions as Array<{ grantee_id: string; role: string }>;
    expect(perms.find((p) => p.grantee_id === grantee1.id)?.role).toBe("editor");
    expect(perms.find((p) => p.grantee_id === grantee2.id)?.role).toBe("admin");
  });

  // --- Entity + space_id + permissions combined ---

  test("Create entity with both space_id and permissions", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("combo-space"));
    const grantee = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });

    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("combo-entity"),
    }, {
      space_id: space.id,
      permissions: [
        { grantee_type: "actor", grantee_id: grantee.id, role: "editor" },
      ],
    });

    // Verify in space
    const { body: spaceBody } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    expect((spaceBody as any).entities.map((e: any) => e.id)).toContain(entity.id);

    // Verify permission
    const { body: permBody } = await getJson(`/wiki/${entity.id}/permissions`, actor.apiKey);
    const perms = (permBody as any).permissions as Array<{ grantee_id: string; role: string }>;
    expect(perms.find((p) => p.grantee_id === grantee.id)?.role).toBe("editor");
  });

  // --- Backwards compatibility ---

  test("Create entity without space_id or permissions still works", async () => {
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("no-extras"),
    });
    expect(entity.id).toBeTruthy();
    expect(entity.ver).toBe(1);
  });

  // --- Validation ---

  test("Invalid permissions array returns 400", async () => {
    const { response } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        type: "note",
        properties: { label: uniqueName("bad-perm") },
        permissions: [{ grantee_type: "invalid", grantee_id: "x", role: "editor" }],
      },
    });
    expect(response.status).toBe(400);
  });

  // --- Relationship + space_id + permissions ---

  test("Create relationship with space_id adds it to space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("rel-space"));
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("rel-src") });
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("rel-tgt") });

    const { response, body } = await jsonRequest(`/wiki/${source.id}/relationships`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        predicate: "references",
        target_id: target.id,
        space_id: space.id,
      },
    });
    expect(response.status).toBe(201);

    const relId = (body as any).relationship.id;

    // Verify relationship entity is in space
    const { body: spaceBody } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    const ids = (spaceBody as any).entities.map((e: any) => e.id);
    expect(ids).toContain(relId);
  });

  test("Create relationship with permissions grants them", async () => {
    const grantee = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("rel-perm-src") });
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("rel-perm-tgt") });

    const { response, body } = await jsonRequest(`/wiki/${source.id}/relationships`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        predicate: "references",
        target_id: target.id,
        permissions: [
          { grantee_type: "actor", grantee_id: grantee.id, role: "editor" },
        ],
      },
    });
    expect(response.status).toBe(201);

    const relId = (body as any).relationship.id;

    // Verify permission on relationship entity
    const { body: permBody } = await getJson(`/wiki/${relId}/permissions`, actor.apiKey);
    const perms = (permBody as any).permissions as Array<{ grantee_id: string; role: string }>;
    expect(perms.find((p) => p.grantee_id === grantee.id)?.role).toBe("editor");
  });

  test("Create relationship with invalid space_id returns 404", async () => {
    const source = await createEntity(actor.apiKey, "note", { label: uniqueName("rel-bad-space-src") });
    const target = await createEntity(actor.apiKey, "note", { label: uniqueName("rel-bad-space-tgt") });

    const { response } = await jsonRequest(`/wiki/${source.id}/relationships`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        predicate: "references",
        target_id: target.id,
        space_id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    expect(response.status).toBe(404);
  });
});
