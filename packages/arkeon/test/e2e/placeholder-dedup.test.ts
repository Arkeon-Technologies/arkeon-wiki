// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for placeholder deduplication.
 *
 * Verifies that POST /wiki/placeholders upserts instead of creating
 * duplicates when placeholders with the same label already exist.
 *
 * Requires a running stack:
 *   npm run test:e2e -- placeholder-dedup
 */

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  createActor,
  createSpace,
  createWiki,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Placeholder deduplication", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;
  let spaceId: string;

  test("setup: create actor and space", async () => {
    actor = await createActor(adminApiKey);
    const space = await createSpace(actor.apiKey, uniqueName("dedup-space"));
    spaceId = space.id;
  });

  test("same label in one batch creates only one placeholder", async () => {
    const label = uniqueName("BatchDup");
    const { response, body } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [
          { label, description: "First" },
          { label, description: "Second" },
          { label, description: "Third" },
        ],
      },
    });

    expect(response.status).toBe(201);
    const data = body as any;
    expect(data.created).toBe(1);
    expect(data.reused).toBe(2);
    expect(data.placeholders).toHaveLength(3);

    // All three should share the same entity ID
    const ids = data.placeholders.map((p: any) => p.id);
    expect(new Set(ids).size).toBe(1);
  });

  test("second request with same label reuses existing placeholder", async () => {
    const label = uniqueName("CrossReqDup");

    // First request — creates the placeholder
    const { response: r1, body: b1 } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [{ label, description: "Pass 1" }],
      },
    });
    expect(r1.status).toBe(201);
    const d1 = b1 as any;
    expect(d1.created).toBe(1);
    expect(d1.reused).toBe(0);
    const originalId = d1.placeholders[0].id;

    // Second request — same label, should reuse
    const { response: r2, body: b2 } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [{ label, description: "Pass 2" }],
      },
    });
    expect(r2.status).toBe(201);
    const d2 = b2 as any;
    expect(d2.created).toBe(0);
    expect(d2.reused).toBe(1);
    expect(d2.placeholders[0].id).toBe(originalId);
  });

  test("case-insensitive dedup (Church vs church vs CHURCH)", async () => {
    const base = uniqueName("CaseDup");

    const { response, body } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [
          { label: base, description: "Original" },
          { label: base.toLowerCase(), description: "Lowercase" },
          { label: base.toUpperCase(), description: "Uppercase" },
        ],
      },
    });

    expect(response.status).toBe(201);
    const data = body as any;
    expect(data.created).toBe(1);
    expect(data.reused).toBe(2);
  });

  test("reused placeholder still gets relationships created", async () => {
    const label = uniqueName("RelDup");

    // Create a "source" wiki to serve as relationship target
    const source = await createWiki(actor.apiKey, uniqueName("source-doc"), "Source document content.", {
      space_id: spaceId,
    });

    // First request — creates the placeholder with a relationship
    const { body: b1 } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [{
          label,
          description: "Extracted subject",
          relationships: [
            { target_id: source.id, predicate: "extracted_from", detail: "Pass 1" },
          ],
        }],
      },
    });
    const d1 = b1 as any;
    expect(d1.created).toBe(1);
    const phId = d1.placeholders[0].id;

    // Second request — same label, should reuse but still create the relationship
    const source2 = await createWiki(actor.apiKey, uniqueName("source-doc-2"), "Second source document.", {
      space_id: spaceId,
    });
    const { body: b2 } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [{
          label,
          description: "Same subject from different source",
          relationships: [
            { target_id: source2.id, predicate: "extracted_from", detail: "Pass 2" },
          ],
        }],
      },
    });
    const d2 = b2 as any;
    expect(d2.created).toBe(0);
    expect(d2.reused).toBe(1);
    expect(d2.placeholders[0].id).toBe(phId);

    // Check that both extracted_from relationships exist
    const { body: relBody } = await getJson(
      `/wiki/${phId}/relationships?direction=out&predicate=extracted_from`,
      actor.apiKey,
    );
    const rels = (relBody as any).relationships;
    expect(rels.length).toBe(2);
    const targetIds = rels.map((r: any) => r.target_id);
    expect(targetIds).toContain(source.id);
    expect(targetIds).toContain(source2.id);
  });

  test("published wiki prevents duplicate placeholder", async () => {
    const label = uniqueName("WikiExists");

    // Create a published wiki with this label
    await createWiki(actor.apiKey, label, `Wiki article about ${label}.`, {
      space_id: spaceId,
    });

    // Try to create a placeholder with the same label — should reuse the wiki
    const { response, body } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [{ label, description: "Should hit existing wiki" }],
      },
    });
    expect(response.status).toBe(201);
    const data = body as any;
    expect(data.created).toBe(0);
    expect(data.reused).toBe(1);
  });

  test("different labels create separate placeholders", async () => {
    const { response, body } = await jsonRequest("/wiki/placeholders", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        space_id: spaceId,
        placeholders: [
          { label: uniqueName("Distinct-A"), description: "First subject" },
          { label: uniqueName("Distinct-B"), description: "Second subject" },
        ],
      },
    });

    expect(response.status).toBe(201);
    const data = body as any;
    expect(data.created).toBe(2);
    expect(data.reused).toBe(0);
    expect(new Set(data.placeholders.map((p: any) => p.id)).size).toBe(2);
  });
});
