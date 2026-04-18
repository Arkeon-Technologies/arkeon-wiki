// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  createActor,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Actors", () => {
  test("Admin can create actor", async () => {
    const actor = await createActor(adminApiKey);
    expect(actor.apiKey).toBeTruthy();
  });

  test("Actor can create another actor", async () => {
    const parent = await createActor(adminApiKey);
    const child = await createActor(parent.apiKey);
    expect(child.apiKey).toBeTruthy();
  });

  test("List actors returns all actors", async () => {
    const actor = await createActor(adminApiKey);
    const { response, body } = await getJson("/actors", actor.apiKey);
    expect(response.status).toBe(200);
    expect((body as any).actors.length).toBeGreaterThan(0);
  });

  test("Get actor by ID", async () => {
    const actor = await createActor(adminApiKey, {
      properties: { label: uniqueName("get-by-id") },
    });
    const { response, body } = await getJson(`/actors/${actor.id}`, adminApiKey);
    expect(response.status).toBe(200);
    expect((body as any).actor.id).toBe(actor.id);
  });

  test("Actor can update own properties", async () => {
    const actor = await createActor(adminApiKey, {
      properties: { label: "original" },
    });
    const { response, body } = await jsonRequest(`/actors/${actor.id}`, {
      method: "PUT",
      apiKey: actor.apiKey,
      json: { properties: { label: "updated" } },
    });
    expect(response.status).toBe(200);
    expect((body as any).actor.properties.label).toBe("updated");
  });

  test("Admin can deactivate actor", async () => {
    const actor = await createActor(adminApiKey);
    const { response, body } = await apiRequest(`/actors/${actor.id}`, {
      method: "DELETE",
      apiKey: adminApiKey,
    });
    expect(response.status).toBe(200);
    expect((body as any).actor.status).toBe("deactivated");
  });

  test("Deactivated actor's API key stops working", async () => {
    const actor = await createActor(adminApiKey);

    // Verify key works before deactivation
    const { response: beforeRes } = await apiRequest("/auth/me", {
      apiKey: actor.apiKey,
    });
    expect(beforeRes.status).toBe(200);

    // Deactivate
    await apiRequest(`/actors/${actor.id}`, {
      method: "DELETE",
      apiKey: adminApiKey,
    });

    // Verify key no longer works
    const { response: afterRes } = await apiRequest("/auth/me", {
      apiKey: actor.apiKey,
    });
    expect([401, 403]).toContain(afterRes.status);
  });
});
