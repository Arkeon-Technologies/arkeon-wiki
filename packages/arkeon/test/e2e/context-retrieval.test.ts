// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  apiRequest,
  createActor,
  createEntity,
  createRelationship,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Context-rich retrieval", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  // Shared entities for tests
  let personA: Record<string, any>;
  let personB: Record<string, any>;
  let orgEntity: Record<string, any>;
  let reportEntity: Record<string, any>;

  test("setup: create actor and test entities with relationships", async () => {
    actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });

    // Create entities
    personA = await createEntity(actor.apiKey, "person", {
      label: uniqueName("ctx-person-a"),
      description: "Intelligence analyst",
    });
    personB = await createEntity(actor.apiKey, "person", {
      label: uniqueName("ctx-person-b"),
      description: "Field operative",
    });
    orgEntity = await createEntity(actor.apiKey, "organization", {
      label: uniqueName("ctx-org"),
      description: "Defense contractor",
    });
    reportEntity = await createEntity(actor.apiKey, "report", {
      label: uniqueName("ctx-report"),
      description: "Quarterly assessment",
    });

    // Create relationships
    await createRelationship(actor.apiKey, personA.id, "works_at", orgEntity.id);
    await createRelationship(actor.apiKey, personB.id, "works_at", orgEntity.id);
    await createRelationship(actor.apiKey, personA.id, "authored", reportEntity.id);
    await createRelationship(actor.apiKey, personA.id, "knows", personB.id);

    // Wait for Meilisearch to index (async background task)
    await new Promise((r) => setTimeout(r, 1500));
  });

  // -------------------------------------------------------
  // GET /wiki/{id}?view=expanded
  // -------------------------------------------------------

  describe("GET /wiki/{id}?view=expanded", () => {
    test("returns entity with _relationships array", async () => {
      const { response, body } = await getJson(
        `/wiki/${personA.id}?view=expanded`,
        actor.apiKey,
      );
      expect(response.status).toBe(200);

      const entity = (body as any).entity;
      expect(entity.id).toBe(personA.id);
      expect(entity.properties.label).toContain("ctx-person-a");
      expect(entity.properties.description).toBe("Intelligence analyst");
      expect(Array.isArray(entity._relationships)).toBe(true);
      expect(entity._relationships.length).toBe(3); // works_at, authored, knows
      expect(entity._relationships_truncated).toBe(false);
    });

    test("each relationship has correct shape with counterpart", async () => {
      const { body } = await getJson(
        `/wiki/${personA.id}?view=expanded`,
        actor.apiKey,
      );
      const rels = (body as any).entity._relationships;

      for (const rel of rels) {
        expect(rel.id).toBeTruthy();
        expect(rel.predicate).toBeTruthy();
        expect(rel.source_id).toBeTruthy();
        expect(rel.target_id).toBeTruthy();
        expect(["in", "out"]).toContain(rel.direction);
        expect(rel.counterpart).toBeTruthy();
        expect(rel.counterpart.id).toBeTruthy();
        expect(rel.counterpart.kind).toBeTruthy();
        expect(rel.counterpart.type).toBeTruthy();
        expect(rel.counterpart.properties).toHaveProperty("label");
      }
    });

    test("counterpart labels match related entities", async () => {
      const { body } = await getJson(
        `/wiki/${personA.id}?view=expanded`,
        actor.apiKey,
      );
      const rels = (body as any).entity._relationships;
      const counterpartLabels = rels.map((r: any) => r.counterpart.properties.label);

      // personA has outbound rels to orgEntity, reportEntity, personB
      expect(counterpartLabels).toContain(orgEntity.properties.label);
      expect(counterpartLabels).toContain(reportEntity.properties.label);
      expect(counterpartLabels).toContain(personB.properties.label);
    });

    test("entity with no relationships returns empty _relationships", async () => {
      const loner = await createEntity(actor.apiKey, "note", {
        label: uniqueName("ctx-loner"),
      });
      const { response, body } = await getJson(
        `/wiki/${loner.id}?view=expanded`,
        actor.apiKey,
      );
      expect(response.status).toBe(200);
      expect((body as any).entity._relationships).toEqual([]);
    });

    test("rel_limit caps the number of relationships returned", async () => {
      const { body } = await getJson(
        `/wiki/${personA.id}?view=expanded&rel_limit=2`,
        actor.apiKey,
      );
      const entity = (body as any).entity;
      expect(entity._relationships.length).toBe(2);
      expect(entity._relationships_truncated).toBe(true); // 3 rels, limit 2
    });

    test("inbound relationships show correct direction", async () => {
      // orgEntity has inbound works_at from personA and personB
      const { body } = await getJson(
        `/wiki/${orgEntity.id}?view=expanded`,
        actor.apiKey,
      );
      const rels = (body as any).entity._relationships;
      const inbound = rels.filter((r: any) => r.direction === "in");
      expect(inbound.length).toBeGreaterThanOrEqual(2);

      for (const rel of inbound) {
        expect(rel.target_id).toBe(orgEntity.id);
      }
    });

    test("default view does NOT include _relationships", async () => {
      const { body } = await getJson(
        `/wiki/${personA.id}`,
        actor.apiKey,
      );
      expect((body as any).entity._relationships).toBeUndefined();
    });

    test("view=summary does NOT include _relationships", async () => {
      const { body } = await getJson(
        `/wiki/${personA.id}?view=summary`,
        actor.apiKey,
      );
      expect((body as any).entity._relationships).toBeUndefined();
    });

    test("404 for nonexistent entity with view=expanded", async () => {
      const { response } = await getJson(
        `/wiki/01ZZZZZZZZZZZZZZZZZZZZZZZZ?view=expanded`,
        actor.apiKey,
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------
  // POST /wiki/bulk
  // -------------------------------------------------------

  describe("POST /wiki/bulk", () => {
    test("returns multiple entities in requested order", async () => {
      const ids = [reportEntity.id, personA.id, orgEntity.id];
      const { response, body } = await jsonRequest("/wiki/bulk", {
        method: "POST",
        apiKey: actor.apiKey,
        json: { ids },
      });
      expect(response.status).toBe(200);

      const entities = (body as any).entities;
      expect(entities.length).toBe(3);
      expect(entities[0].id).toBe(reportEntity.id);
      expect(entities[1].id).toBe(personA.id);
      expect(entities[2].id).toBe(orgEntity.id);
    });

    test("silently omits nonexistent IDs", async () => {
      const ids = [personA.id, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", orgEntity.id];
      const { response, body } = await jsonRequest("/wiki/bulk", {
        method: "POST",
        apiKey: actor.apiKey,
        json: { ids },
      });
      expect(response.status).toBe(200);

      const entities = (body as any).entities;
      expect(entities.length).toBe(2);
      expect(entities[0].id).toBe(personA.id);
      expect(entities[1].id).toBe(orgEntity.id);
    });

    test("supports view=summary", async () => {
      const { response, body } = await apiRequest(
        "/wiki/bulk?view=summary",
        {
          method: "POST",
          apiKey: actor.apiKey,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [personA.id] }),
        },
      );
      expect(response.status).toBe(200);

      const entity = (body as any).entities[0];
      expect(entity.id).toBe(personA.id);
      // summary view only has label in properties
      expect(entity.properties.label).toBeTruthy();
      expect(entity.properties.description).toBeUndefined();
    });

    test("supports view=expanded with relationships", async () => {
      const { response, body } = await apiRequest(
        "/wiki/bulk?view=expanded",
        {
          method: "POST",
          apiKey: actor.apiKey,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [personA.id, orgEntity.id] }),
        },
      );
      expect(response.status).toBe(200);

      const entities = (body as any).entities;
      expect(entities.length).toBe(2);

      // personA should have relationships
      const pa = entities[0];
      expect(pa.id).toBe(personA.id);
      expect(Array.isArray(pa._relationships)).toBe(true);
      expect(pa._relationships.length).toBeGreaterThan(0);

      // orgEntity should have inbound relationships
      const org = entities[1];
      expect(org.id).toBe(orgEntity.id);
      expect(Array.isArray(org._relationships)).toBe(true);
      expect(org._relationships.length).toBeGreaterThan(0);
    });

    test("rel_limit applies per entity in bulk expanded view", async () => {
      const { body } = await apiRequest(
        "/wiki/bulk?view=expanded&rel_limit=1",
        {
          method: "POST",
          apiKey: actor.apiKey,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [personA.id, orgEntity.id] }),
        },
      );

      for (const entity of (body as any).entities) {
        expect(entity._relationships.length).toBeLessThanOrEqual(1);
      }
    });

    test("empty ids array returns 400", async () => {
      const { response } = await jsonRequest("/wiki/bulk", {
        method: "POST",
        apiKey: actor.apiKey,
        json: { ids: [] },
      });
      expect(response.status).toBe(400);
    });

    test("RLS hides entities above actor clearance", async () => {
      // Create a high-clearance entity
      const secret = await createEntity(adminApiKey, "report", {
        label: uniqueName("ctx-secret"),
      }, { read_level: 4 });

      // Low-clearance actor cannot see it
      const { body } = await jsonRequest("/wiki/bulk", {
        method: "POST",
        apiKey: actor.apiKey,
        json: { ids: [personA.id, secret.id] },
      });
      const ids = (body as any).entities.map((e: any) => e.id);
      expect(ids).toContain(personA.id);
      expect(ids).not.toContain(secret.id);
    });
  });

  // -------------------------------------------------------
  // POST /search/multi
  // -------------------------------------------------------

  describe("POST /search/multi", () => {
    test("returns results or 503 depending on Meilisearch availability", async () => {
      const { response, body } = await jsonRequest("/search/multi", {
        method: "POST",
        apiKey: actor.apiKey,
        json: {
          queries: [{ q: "test" }],
        },
      });

      if (response.status === 503) {
        // Meilisearch not configured — acceptable
        expect((body as any).error.code).toBe("service_unavailable");
      } else {
        expect(response.status).toBe(200);
        expect(Array.isArray((body as any).results)).toBe(true);
        expect((body as any).results.length).toBe(1);
        expect((body as any).results[0].q).toBe("test");
      }
    });

    test("returns 400 for empty queries array", async () => {
      const { response } = await jsonRequest("/search/multi", {
        method: "POST",
        apiKey: actor.apiKey,
        json: { queries: [] },
      });
      // Either 400 (validation) or 503 (no Meili) — both are acceptable
      expect([400, 503]).toContain(response.status);
    });

    test("multiple queries return independent result sets", async () => {
      const { response, body } = await jsonRequest("/search/multi", {
        method: "POST",
        apiKey: actor.apiKey,
        json: {
          queries: [
            { q: personA.properties.label, limit: 5 },
            { q: orgEntity.properties.label, limit: 5 },
          ],
        },
      });

      if (response.status === 503) return; // skip if no Meili
      expect(response.status).toBe(200);

      const results = (body as any).results;
      expect(results.length).toBe(2);
      expect(results[0].q).toBe(personA.properties.label);
      expect(results[1].q).toBe(orgEntity.properties.label);

      // Each query should find at least one result matching the label
      const q0Labels = results[0].results.map((r: any) => r.properties.label);
      const q1Labels = results[1].results.map((r: any) => r.properties.label);
      expect(q0Labels).toContain(personA.properties.label);
      expect(q1Labels).toContain(orgEntity.properties.label);
    });

    test("multi-search with view=expanded includes relationships", async () => {
      const { response, body } = await jsonRequest("/search/multi", {
        method: "POST",
        apiKey: actor.apiKey,
        json: {
          queries: [{ q: personA.properties.label, limit: 5 }],
          view: "expanded",
        },
      });

      if (response.status === 503) return; // skip if no Meili
      expect(response.status).toBe(200);

      const results = (body as any).results[0].results;
      if (results.length > 0) {
        const entity = results[0];
        expect(Array.isArray(entity._relationships)).toBe(true);
        // personA has relationships
        expect(entity._relationships.length).toBeGreaterThan(0);
        for (const rel of entity._relationships) {
          expect(rel.counterpart).toBeTruthy();
          expect(rel.counterpart.properties.label).toBeTruthy();
        }
      }
    });
  });

  // -------------------------------------------------------
  // GET /search?view=expanded
  // -------------------------------------------------------

  describe("GET /search?view=expanded", () => {
    test("search with view=expanded includes relationships in results", async () => {
      const { response, body } = await apiRequest(
        `/search?q=${encodeURIComponent(personA.properties.label)}&view=expanded`,
        { apiKey: actor.apiKey },
      );

      if (response.status === 503) return; // skip if no Meili
      expect(response.status).toBe(200);

      const results = (body as any).results;
      // Find our specific entity in the results
      const match = results.find((r: any) => r.id === personA.id);
      expect(match).toBeTruthy();
      expect(Array.isArray(match._relationships)).toBe(true);
      expect(match._relationships.length).toBeGreaterThan(0);

      const counterpartIds = match._relationships.map(
        (r: any) => r.counterpart.id,
      );
      expect(counterpartIds).toContain(orgEntity.id);
    });

    test("search without view=expanded does not include relationships", async () => {
      const { response, body } = await apiRequest(
        `/search?q=${encodeURIComponent(personA.properties.label)}`,
        { apiKey: actor.apiKey },
      );

      if (response.status === 503) return; // skip if no Meili
      expect(response.status).toBe(200);

      const results = (body as any).results;
      if (results.length > 0) {
        expect(results[0]._relationships).toBeUndefined();
      }
    });
  });
});
