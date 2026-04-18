// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { adminApiKey, apiRequest, getJson } from "./helpers";

describe("Bootstrap", () => {
  test("Health check returns 200 with arkeon-api", async () => {
    const { response, body } = await apiRequest("/");
    expect(response.status).toBe(200);
    expect(body).toHaveProperty("name", "arkeon-api");
  });

  test("GET /auth/me with admin key returns actor", async () => {
    const { response, body } = await getJson("/auth/me", adminApiKey);
    expect(response.status).toBe(200);
    expect((body as any).actor.id).toBeTruthy();
  });

  test("Unauthenticated GET /auth/me returns 401", async () => {
    const { response } = await apiRequest("/auth/me");
    expect(response.status).toBe(401);
  });
});
