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
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Spaces", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey);
  });

  test("Create space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("test-space"));
    expect(space.id).toBeTruthy();
    expect(space.name).toContain("test-space");
  });

  test("List spaces", async () => {
    await createSpace(actor.apiKey, uniqueName("list-space"));
    const { response, body } = await getJson("/spaces", actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).spaces.length).toBeGreaterThan(0);
  });

  test("List entities in space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("list-entities-space"));
    const entity1 = await createEntity(actor.apiKey, "note", {
      label: uniqueName("e1"),
    });
    const entity2 = await createEntity(actor.apiKey, "note", {
      label: uniqueName("e2"),
    });
    await addEntityToSpace(actor.apiKey, space.id, entity1.id);
    await addEntityToSpace(actor.apiKey, space.id, entity2.id);

    const { response, body } = await getJson(`/spaces/${space.id}/entities`, actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).entities.length).toBeGreaterThanOrEqual(2);
  });

  test("Remove entity from space", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("remove-space"));
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("to-remove"),
    });
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

  test("Space feed shows activity", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("feed-space"));
    const entity = await createEntity(actor.apiKey, "note", {
      label: uniqueName("feed-entity"),
    });
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
