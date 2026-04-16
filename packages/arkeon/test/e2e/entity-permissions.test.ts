// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  addGroupMember,
  createActor,
  createEntity,
  createGroup,
  getJson,
  grantEntityPermission,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Entity permissions", () => {
  let owner: Awaited<ReturnType<typeof createActor>>;
  let otherActor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actors", async () => {
    owner = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    otherActor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
  });

  test("Owner can grant editor role to another actor", async () => {
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: uniqueName("perm-editor") },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "actor", otherActor.id, "editor");

    const { response, body } = await getJson(`/wiki/${entity.id}/permissions`, owner.apiKey);
    expect(response.status).toBe(200);
    const perms = (body as any).permissions;
    expect(perms.some((p: any) => p.grantee_id === otherActor.id && p.role === "editor")).toBe(true);
  });

  test("Editor can update entity", async () => {
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: "before-edit" },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "actor", otherActor.id, "editor");

    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: otherActor.apiKey,
      json: { ver: entity.ver, properties: { label: "after-edit" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.properties.label).toBe("after-edit");
  });

  test("Editor cannot delete entity (needs admin)", async () => {
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: uniqueName("editor-no-delete") },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "actor", otherActor.id, "editor");

    const { response } = await apiRequest(`/wiki/${entity.id}`, {
      method: "DELETE",
      apiKey: otherActor.apiKey,
    });
    expect(response.status).toBe(403);
  });

  test("Owner can grant admin role", async () => {
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: uniqueName("perm-admin") },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "actor", otherActor.id, "admin");

    const { response, body } = await getJson(`/wiki/${entity.id}/permissions`, owner.apiKey);
    expect(response.status).toBe(200);
    const perms = (body as any).permissions;
    expect(perms.some((p: any) => p.grantee_id === otherActor.id && p.role === "admin")).toBe(true);
  });

  test("Admin-granted actor can delete entity", async () => {
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: uniqueName("admin-delete") },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "actor", otherActor.id, "admin");

    const { response } = await apiRequest(`/wiki/${entity.id}`, {
      method: "DELETE",
      apiKey: otherActor.apiKey,
    });
    expect(response.status).toBe(204);
  });

  test("Non-owner/non-editor cannot update", async () => {
    const bystander = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: uniqueName("no-access") },
      { read_level: 1, write_level: 1 },
    );

    const { response } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: bystander.apiKey,
      json: { ver: entity.ver, properties: { label: "nope" } },
    });
    expect(response.status).toBe(403);
  });

  test("Group-based permissions: create group, add actor, grant group editor role, actor can edit", async () => {
    const group = await createGroup(adminApiKey, uniqueName("editor-group"));
    const member = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    await addGroupMember(adminApiKey, group.id, member.id);

    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: "group-edit-target" },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "group", group.id, "editor");

    const { response, body } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: member.apiKey,
      json: { ver: entity.ver, properties: { label: "group-edited" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.properties.label).toBe("group-edited");
  });

  test("Revoke permission: editor loses access", async () => {
    const editor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: "revoke-target" },
      { read_level: 1, write_level: 1 },
    );
    await grantEntityPermission(owner.apiKey, entity.id, "actor", editor.id, "editor");

    // Verify editor can update
    const { response: okRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: editor.apiKey,
      json: { ver: entity.ver, properties: { label: "edited" } },
    });
    expect(okRes.status).toBe(200);

    // Revoke
    const { response: revokeRes } = await apiRequest(
      `/wiki/${entity.id}/permissions/${editor.id}`,
      { method: "DELETE", apiKey: owner.apiKey },
    );
    expect(revokeRes.status).toBe(204);

    // Re-fetch entity to get current ver
    const { body: freshBody } = await getJson(`/wiki/${entity.id}`, owner.apiKey);
    const freshVer = (freshBody as any).entity.ver;

    // Verify editor can no longer update
    const { response: failRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: editor.apiKey,
      json: { ver: freshVer, properties: { label: "should-fail" } },
    });
    expect(failRes.status).toBe(403);
  });

  test("Transfer ownership", async () => {
    const newOwner = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const entity = await createEntity(
      owner.apiKey,
      "note",
      { label: uniqueName("transfer") },
      { read_level: 1, write_level: 1 },
    );

    const { response, body } = await jsonRequest(`/wiki/${entity.id}/owner`, {
      method: "PUT",
      apiKey: owner.apiKey,
      json: { owner_id: newOwner.id },
    });
    expect(response.status).toBe(200);
    expect((body as any).entity.owner_id).toBe(newOwner.id);

    // New owner can edit
    const { response: editRes } = await jsonRequest(`/wiki/${entity.id}`, {
      method: "PUT",
      apiKey: newOwner.apiKey,
      json: { ver: entity.ver, properties: { label: "new-owner-edit" } },
    });
    expect(editRes.status).toBe(200);
  });
});
