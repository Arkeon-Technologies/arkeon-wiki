// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  addEntityToSpace,
  addGroupMember,
  apiRequest,
  createActor,
  createEntity,
  createGroup,
  createSpace,
  getJson,
  grantSpaceEntityAccess,
  grantSpacePermission,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Spaces", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey, {
      maxReadLevel: 3,
      maxWriteLevel: 3,
    });
  });

  test("Create space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("test-space"));
    expect(space.id).toBeTruthy();
    expect(space.name).toContain("test-space");
  });

  test("List spaces (filtered by read_level via RLS)", async () => {
    const level1Actor = await createActor(adminApiKey, {
      maxReadLevel: 1,
      maxWriteLevel: 1,
    });

    // Create a public space (read_level=0) and an elevated space (read_level=2)
    await createSpace(actor.apiKey, uniqueName("public-space"), { read_level: 0 });
    const secretSpace = await createSpace(actor.apiKey, uniqueName("secret-space"), {
      read_level: 2,
    });

    // Level-1 actor should see public but not secret
    const { response, body } = await getJson("/spaces", level1Actor.apiKey);
    expect(response.status).toBe(200);
    const spaceIds = (body as any).spaces.map((s: any) => s.id);
    expect(spaceIds).not.toContain(secretSpace.id);
  });

  test("Add entity to space (as contributor)", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("add-entity-space"));
    const contributor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    await grantSpacePermission(actor.apiKey, space.id, "actor", contributor.id, "contributor");

    const entity = await createEntity(
      contributor.apiKey,
      "note",
      { label: uniqueName("in-space") },
      { read_level: 1, write_level: 1 },
    );

    await addEntityToSpace(contributor.apiKey, space.id, entity.id);

    const { response, body } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    expect(response.status).toBe(200);
    const entityIds = (body as any).entities.map((e: any) => e.id);
    expect(entityIds).toContain(entity.id);
  });

  test("List entities in space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("list-entities-space"));
    const entity1 = await createEntity(
      actor.apiKey,
      "note",
      { label: uniqueName("e1") },
      { read_level: 1, write_level: 1 },
    );
    const entity2 = await createEntity(
      actor.apiKey,
      "note",
      { label: uniqueName("e2") },
      { read_level: 1, write_level: 1 },
    );
    await addEntityToSpace(actor.apiKey, space.id, entity1.id);
    await addEntityToSpace(actor.apiKey, space.id, entity2.id);

    const { response, body } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).entities.length).toBeGreaterThanOrEqual(2);
  });

  test("Remove entity from space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("remove-space"));
    const entity = await createEntity(
      actor.apiKey,
      "note",
      { label: uniqueName("to-remove") },
      { read_level: 1, write_level: 1 },
    );
    await addEntityToSpace(actor.apiKey, space.id, entity.id);

    const { response } = await apiRequest(`/spaces/${space.id}/wiki/${entity.id}`, {
      method: "DELETE",
      apiKey: actor.apiKey,
    });
    expect(response.status).toBe(204);

    // Verify entity is no longer in space
    const { body } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    const entityIds = (body as any).entities.map((e: any) => e.id);
    expect(entityIds).not.toContain(entity.id);
  });

  test("Non-contributor cannot add entity to space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("no-contrib-space"));
    const outsider = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const entity = await createEntity(
      outsider.apiKey,
      "note",
      { label: uniqueName("no-add") },
      { read_level: 1, write_level: 1 },
    );

    const { response } = await jsonRequest(`/spaces/${space.id}/entities`, {
      method: "POST",
      apiKey: outsider.apiKey,
      json: { entity_id: entity.id },
    });
    expect(response.status).toBe(403);
  });

  test("Space permissions: grant contributor, editor, admin", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("perm-space"));
    const target = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });

    // Grant contributor
    await grantSpacePermission(actor.apiKey, space.id, "actor", target.id, "contributor");
    let { body } = await getJson(`/spaces/${space.id}/permissions`, actor.apiKey);
    expect((body as any).permissions.some((p: any) => p.grantee_id === target.id && p.role === "contributor")).toBe(true);

    // Upgrade to editor
    await grantSpacePermission(actor.apiKey, space.id, "actor", target.id, "editor");
    ({ body } = await getJson(`/spaces/${space.id}/permissions`, actor.apiKey));
    expect((body as any).permissions.some((p: any) => p.grantee_id === target.id && p.role === "editor")).toBe(true);

    // Upgrade to admin
    await grantSpacePermission(actor.apiKey, space.id, "actor", target.id, "admin");
    ({ body } = await getJson(`/spaces/${space.id}/permissions`, actor.apiKey));
    expect((body as any).permissions.some((p: any) => p.grantee_id === target.id && p.role === "admin")).toBe(true);
  });

  test("Bulk grant permissions on a space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("bulk-perm-space"));
    const actor1 = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });
    const actor2 = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });
    const actor3 = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });

    // Bulk grant contributor to all 3 actors
    const { response, body } = await jsonRequest(`/spaces/${space.id}/permissions`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        grants: [
          { grantee_id: actor1.id, role: "contributor" },
          { grantee_id: actor2.id, role: "contributor" },
          { grantee_id: actor3.id, role: "editor" },
        ],
      },
    });
    expect(response.status).toBe(201);
    const perms = (body as any).permissions;
    expect(perms).toHaveLength(3);
    expect(perms[0].grantee_id).toBe(actor1.id);
    expect(perms[0].role).toBe("contributor");
    expect(perms[2].grantee_id).toBe(actor3.id);
    expect(perms[2].role).toBe("editor");

    // Verify actor1 can add entities to the space
    const entity = await createEntity(actor1.apiKey, "note", {
      label: uniqueName("bulk-test-entity"),
    });
    await addEntityToSpace(actor1.apiKey, space.id, entity.id);

    const { body: spaceEntities } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    expect((spaceEntities as any).entities.some((e: any) => e.id === entity.id)).toBe(true);
  });

  test("Space permission 403 includes descriptive message", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("403-msg-space"));
    const unprivileged = await createActor(adminApiKey, { maxReadLevel: 2, maxWriteLevel: 2 });
    const entity = await createEntity(unprivileged.apiKey, "note", {
      label: uniqueName("403-msg-entity"),
    });

    // Try to add entity without contributor role
    const { response, body } = await jsonRequest(`/spaces/${space.id}/entities`, {
      method: "POST",
      apiKey: unprivileged.apiKey,
      json: { entity_id: entity.id },
    });
    expect(response.status).toBe(403);
    expect((body as any).error.message).toContain("no role on this space");
    expect((body as any).error.message).toContain("/permissions");
  });

  // -- Space Entity Access tests ------------------------------------------------

  test("Entity-access: grant gives edit access to entities in space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("ea-grant"));
    const user = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });
    const entity = await createEntity(actor.apiKey, "note", { label: "ea-doc" }, { read_level: 1, write_level: 1 });
    await addEntityToSpace(actor.apiKey, space.id, entity.id);

    // Before grant: user cannot edit
    const { response: failRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: entity.ver, properties: { label: "hacked" } },
    });
    expect(failRes.status).toBe(403);

    // Grant entity-access
    await grantSpaceEntityAccess(actor.apiKey, space.id, "actor", user.id, "editor");

    // After grant: user can edit
    const { response: okRes, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: entity.ver, properties: { label: "modified-via-space" } },
    });
    expect(okRes.status).toBe(200);
    expect((body as any).entity.properties.label).toBe("modified-via-space");
  });

  test("Entity-access: does not grant access to entities outside the space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("ea-outside"));
    const user = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });
    const insideEntity = await createEntity(actor.apiKey, "note", { label: "inside" }, { read_level: 1, write_level: 1 });
    const outsideEntity = await createEntity(actor.apiKey, "note", { label: "outside" }, { read_level: 1, write_level: 1 });
    await addEntityToSpace(actor.apiKey, space.id, insideEntity.id);

    await grantSpaceEntityAccess(actor.apiKey, space.id, "actor", user.id, "editor");

    // Can edit inside entity
    const { response: okRes } = await jsonRequest(`/wiki/${insideEntity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: insideEntity.ver, properties: { label: "ok" } },
    });
    expect(okRes.status).toBe(200);

    // Cannot edit outside entity
    const { response: failRes } = await jsonRequest(`/wiki/${outsideEntity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: outsideEntity.ver, properties: { label: "no" } },
    });
    expect(failRes.status).toBe(403);
  });

  test("Entity-access: revoke removes access", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("ea-revoke"));
    const user = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });
    const entity = await createEntity(actor.apiKey, "note", { label: "rev-doc" }, { read_level: 1, write_level: 1 });
    await addEntityToSpace(actor.apiKey, space.id, entity.id);
    await grantSpaceEntityAccess(actor.apiKey, space.id, "actor", user.id, "editor");

    // Edit works
    const { response: okRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: entity.ver, properties: { label: "edited" } },
    });
    expect(okRes.status).toBe(200);

    // Revoke
    const { response: revokeRes } = await apiRequest(`/spaces/${space.id}/entity-access/${user.id}`, {
      method: "DELETE",
      apiKey: actor.apiKey,
    });
    expect(revokeRes.status).toBe(204);

    // Edit now fails
    const { response: failRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: 2, properties: { label: "should-fail" } },
    });
    expect(failRes.status).toBe(403);
  });

  test("Entity-access: list and bulk grant", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("ea-bulk"));
    const user1 = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });
    const user2 = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });

    // Bulk grant
    const { response: bulkRes, body: bulkBody } = await jsonRequest(`/spaces/${space.id}/entity-access`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        grants: [
          { grantee_type: "actor", grantee_id: user1.id, role: "editor" },
          { grantee_type: "actor", grantee_id: user2.id, role: "admin" },
        ],
      },
    });
    expect(bulkRes.status).toBe(201);
    expect((bulkBody as any).grants).toHaveLength(2);

    // List
    const { response: listRes, body: listBody } = await getJson(`/spaces/${space.id}/entity-access`, actor.apiKey);
    expect(listRes.status).toBe(200);
    expect((listBody as any).grants).toHaveLength(2);
    expect((listBody as any).grants.some((g: any) => g.grantee_id === user1.id && g.role === "editor")).toBe(true);
    expect((listBody as any).grants.some((g: any) => g.grantee_id === user2.id && g.role === "admin")).toBe(true);
  });

  test("Entity-access: group grant cascades to group members", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("ea-group"));
    const group = await createGroup(adminApiKey, uniqueName("ea-grp"));
    const member = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });
    await addGroupMember(adminApiKey, group.id, member.id);

    const entity = await createEntity(actor.apiKey, "note", { label: "grp-doc" }, { read_level: 1, write_level: 1 });
    await addEntityToSpace(actor.apiKey, space.id, entity.id);

    // Before grant: member cannot edit
    const { response: failRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: member.apiKey,
      json: { ver: entity.ver, properties: { label: "no" } },
    });
    expect(failRes.status).toBe(403);

    // Grant entity-access to group
    await grantSpaceEntityAccess(actor.apiKey, space.id, "group", group.id, "editor");

    // After grant: member can edit
    const { response: okRes, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: member.apiKey,
      json: { ver: entity.ver, properties: { label: "edited-via-group" } },
    });
    expect(okRes.status).toBe(200);
    expect((body as any).entity.properties.label).toBe("edited-via-group");
  });

  test("Entity-access: removing entity from space revokes cascaded access", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("ea-remove"));
    const user = await createActor(adminApiKey, { maxReadLevel: 1, maxWriteLevel: 1 });
    const entity = await createEntity(actor.apiKey, "note", { label: "rm-doc" }, { read_level: 1, write_level: 1 });
    await addEntityToSpace(actor.apiKey, space.id, entity.id);
    await grantSpaceEntityAccess(actor.apiKey, space.id, "actor", user.id, "editor");

    // Can edit while entity is in space
    const { response: okRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: entity.ver, properties: { label: "ok" } },
    });
    expect(okRes.status).toBe(200);

    // Remove entity from space
    const { response: removeRes } = await apiRequest(`/spaces/${space.id}/wiki/${entity.id}`, {
      method: "DELETE",
      apiKey: actor.apiKey,
    });
    expect(removeRes.status).toBe(204);

    // Cannot edit after entity removed from space
    const { response: failRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: user.apiKey,
      json: { ver: 2, properties: { label: "should-fail" } },
    });
    expect(failRes.status).toBe(403);
  });

  test("Space feed shows activity", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("feed-space"));
    const entity = await createEntity(
      actor.apiKey,
      "note",
      { label: uniqueName("feed-entity") },
      { read_level: 1, write_level: 1 },
    );
    await addEntityToSpace(actor.apiKey, space.id, entity.id);

    // Update entity to generate activity
    await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { ver: entity.ver, properties: { label: "updated-for-feed" } },
    });

    // Small delay for background activity writes
    await new Promise((r) => setTimeout(r, 500));

    const { response, body } = await getJson(`/spaces/${space.id}/feed`, actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).activity.length).toBeGreaterThan(0);
  });
});
