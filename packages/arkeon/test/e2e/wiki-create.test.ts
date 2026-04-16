// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  createActor,
  createEntity,
  createSpace,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

describe("Wiki create", () => {
  let actor: Awaited<ReturnType<typeof createActor>>;

  test("setup: create actor", async () => {
    actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
  });

  test("publishes canonical content and creates relationships for entity, draft, and gap links", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-space"));
    const primary = await createEntity(actor.apiKey, "topic", {
      label: uniqueName("wiki-primary"),
      description: "Primary wiki subject",
    }, { space_id: space.id });
    const referenced = await createEntity(actor.apiKey, "person", {
      label: uniqueName("wiki-ref"),
      description: "Known referenced person",
    }, { space_id: space.id });

    const content = [
      `This wiki is about the primary subject and cites [[entity:${referenced.id}]] in context.`,
      `It promises a future page for [[draft:"Draft Concept"|"A concept the author intends to expand"]].`,
      `It also marks an open gap for [[gap:"Gap Concept"|"A concept nobody committed to draft"]].`,
    ].join("\n\n");

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content,
        primary_entities: [primary.id],
        space_id: space.id,
      },
    });

    expect(response.status).toBe(201);
    const created = body as any;
    const wiki = created.wiki;
    expect(wiki.type).toBe("wiki");
    expect(wiki.properties.status).toBe("published");
    expect(wiki.properties.submitted_content).toBe(content);
    expect(created.relationships_created).toBe(4);

    const draft = created.placeholders.find((p: any) => p.label === "Draft Concept");
    const gap = created.placeholders.find((p: any) => p.label === "Gap Concept");
    expect(draft).toBeTruthy();
    expect(draft.status).toBe("draft");
    expect(gap).toBeTruthy();
    expect(gap.status).toBe("gap");

    expect(wiki.properties.content).toContain(`[[entity:${referenced.id}]]`);
    expect(wiki.properties.content).toContain(`[[entity:${draft.id}]]`);
    expect(wiki.properties.content).toContain(`[[entity:${gap.id}]]`);
    expect(wiki.properties.content).not.toContain("[[draft:");
    expect(wiki.properties.content).not.toContain("[[gap:");

    const { response: relResponse, body: relBody } = await getJson(
      `/entities/${wiki.id}/relationships?direction=out&limit=20`,
      actor.apiKey,
    );
    expect(relResponse.status).toBe(200);
    const rels = (relBody as any).relationships;
    expect(rels.some((r: any) => r.predicate === "about" && r.target_id === primary.id)).toBe(true);
    expect(rels.some((r: any) => r.predicate === "references" && r.target_id === referenced.id)).toBe(true);

    const draftRel = rels.find((r: any) => r.target_id === draft.id);
    expect(draftRel).toBeTruthy();
    expect(draftRel.properties.span_text).toContain("future page");

    const gapRel = rels.find((r: any) => r.target_id === gap.id);
    expect(gapRel).toBeTruthy();
    expect(gapRel.properties.span_text).toContain("open gap");
  });

  test("rejects malformed bare wiki links", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-bad-space"));
    const primary = await createEntity(actor.apiKey, "topic", {
      label: uniqueName("wiki-bad-primary"),
    }, { space_id: space.id });

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: "This should fail because [[Bare Link]] has no typed intent.",
        primary_entities: [primary.id],
        space_id: space.id,
      },
    });

    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("malformed_wiki_links");
    expect((body as any).error.details.links[0].raw).toBe("[[Bare Link]]");
  });

  test("depth limit turns new draft and resolve targets into non-queued gap placeholders", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-depth-space"));
    const primary = await createEntity(actor.apiKey, "topic", {
      label: uniqueName("wiki-depth-primary"),
    }, { space_id: space.id });

    const content = [
      `Depth-limited draft [[draft:"Depth Draft ${uniqueName("x")}"|"should become gap"]].`,
      `Depth-limited resolve [[resolve:"Depth Resolve ${uniqueName("x")}"|"should become gap if no match"]].`,
    ].join("\n");

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content,
        primary_entities: [primary.id],
        space_id: space.id,
        depth: 2,
      },
    });

    expect(response.status).toBe(201);
    const created = body as any;
    expect(created.placeholders).toHaveLength(2);
    expect(created.placeholders.every((p: any) => p.status === "gap")).toBe(true);
    expect(created.wiki.properties.content).not.toContain("[[draft:");
    expect(created.wiki.properties.content).not.toContain("[[resolve:");
    expect(created.wiki.properties.content.match(/\[\[entity:/g)).toHaveLength(2);

    for (const placeholder of created.placeholders) {
      const { response: phResponse, body: phBody } = await getJson(
        `/entities/${placeholder.id}`,
        actor.apiKey,
      );
      expect(phResponse.status).toBe(200);
      expect((phBody as any).entity.type).toBe("placeholder");
      expect((phBody as any).entity.properties.status).toBe("gap");
    }
  });

  test("entity links to merged IDs are accepted and rewritten to canonical targets", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-redirect-space"));
    const primary = await createEntity(actor.apiKey, "topic", {
      label: uniqueName("wiki-redirect-primary"),
    }, { space_id: space.id });
    const target = await createEntity(actor.apiKey, "person", {
      label: uniqueName("wiki-redirect-target"),
    }, { space_id: space.id });
    const source = await createEntity(actor.apiKey, "person", {
      label: uniqueName("wiki-redirect-source"),
    }, { space_id: space.id });

    const { response: mergeResponse } = await jsonRequest(`/entities/${target.id}/merge`, {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        source_id: source.id,
        property_strategy: "keep_target",
        ver: target.ver,
      },
    });
    expect(mergeResponse.status).toBe(200);

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: `This mentions a merged entity [[entity:${source.id}]] that should canonicalize.`,
        primary_entities: [primary.id],
        space_id: space.id,
      },
    });

    expect(response.status).toBe(201);
    const wiki = (body as any).wiki;
    expect(wiki.properties.content).toContain(`[[entity:${target.id}]]`);
    expect(wiki.properties.content).not.toContain(source.id);

    const { body: relBody } = await getJson(
      `/entities/${wiki.id}/relationships?direction=out&target_id=${target.id}`,
      actor.apiKey,
    );
    expect((relBody as any).relationships.some((r: any) => r.target_id === target.id)).toBe(true);
  });

  test("concurrent submissions with overlapping primary entities return one winner", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-concurrent-space"));
    const primary = await createEntity(actor.apiKey, "topic", {
      label: uniqueName("wiki-concurrent-primary"),
    }, { space_id: space.id });

    const payload = {
      content: "Concurrent wiki with no secondary links.",
      primary_entities: [primary.id],
      space_id: space.id,
    };

    const results = await Promise.all([
      jsonRequest("/wiki", { method: "POST", apiKey: actor.apiKey, json: payload }),
      jsonRequest("/wiki", { method: "POST", apiKey: actor.apiKey, json: payload }),
    ]);

    const statuses = results.map((r) => r.response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = results.find((r) => r.response.status === 409);
    expect((conflict?.body as any).error.code).toBe("wiki_exists");
    expect((conflict?.body as any).error.details.existing_wiki_id).toBeTruthy();
  });
});
