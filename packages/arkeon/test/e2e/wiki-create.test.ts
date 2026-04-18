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
    actor = await createActor(adminApiKey);
  });

  test("publishes canonical content and creates relationships for entity, placeholder, and assign links", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-space"));
    const referenced = await createEntity(actor.apiKey, "person", {
      label: uniqueName("wiki-ref"),
      description: "Known referenced person",
    }, { space_id: space.id });

    const content = [
      `This wiki cites [[entity:${referenced.id}]] in context.`,
      `It promises a future page for [[assign:"Assigned Concept"|"A concept the author intends to expand"]].`,
      `It also marks an open placeholder for [[placeholder:"Placeholder Concept"|"A concept nobody committed to draft"]].`,
    ].join("\n\n");

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content,
        label: "Primary Subject Wiki",
        subject_type: "topic",
        aliases: ["Primary Subject"],
        keywords: ["primary subject", "test wiki", "linked wiki"],
        short_description: "A test wiki that exercises entity, assign, and placeholder link types end to end.",
        space_id: space.id,
      },
    });

    expect(response.status).toBe(201);
    const created = body as any;
    const wiki = created.wiki;
    expect(wiki.type).toBe("wiki");
    expect(wiki.properties.status).toBe("published");
    expect(wiki.properties.submitted_content).toBe(content);
    expect(wiki.properties.label).toBe("Primary Subject Wiki");
    expect(wiki.properties.subject_type).toBe("topic");
    expect(wiki.properties.aliases).toEqual(["Primary Subject"]);
    expect(wiki.properties.keywords).toEqual(["primary subject", "test wiki", "linked wiki"]);
    expect(wiki.properties.short_description).toContain("test wiki");
    expect(created.relationships_created).toBe(3);

    const assigned = created.placeholders.find((p: any) => p.label === "Assigned Concept");
    const placeholder = created.placeholders.find((p: any) => p.label === "Placeholder Concept");
    expect(assigned).toBeTruthy();
    expect(assigned.status).toBe("assigned");
    expect(placeholder).toBeTruthy();
    expect(placeholder.status).toBe("placeholder");

    expect(wiki.properties.content).toContain(`[[entity:${referenced.id}]]`);
    expect(wiki.properties.content).toContain(`[[entity:${assigned.id}]]`);
    expect(wiki.properties.content).toContain(`[[entity:${placeholder.id}]]`);
    expect(wiki.properties.content).not.toContain("[[assign:");
    expect(wiki.properties.content).not.toContain("[[placeholder:");

    const { response: relResponse, body: relBody } = await getJson(
      `/wiki/${wiki.id}/relationships?direction=out&limit=20`,
      actor.apiKey,
    );
    expect(relResponse.status).toBe(200);
    const rels = (relBody as any).relationships;
    expect(rels.some((r: any) => r.predicate === "references" && r.target_id === referenced.id)).toBe(true);

    const assignRel = rels.find((r: any) => r.target_id === assigned.id);
    expect(assignRel).toBeTruthy();
    expect(assignRel.properties.span_text).toContain("future page");

    const placeholderRel = rels.find((r: any) => r.target_id === placeholder.id);
    expect(placeholderRel).toBeTruthy();
    expect(placeholderRel.properties.span_text).toContain("open placeholder");
  });

  test("rejects malformed bare wiki links", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-bad-space"));

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: "This should fail because [[Bare Link]] has no typed intent.",
        label: "Bad Wiki",
        keywords: ["bad wiki"],
        short_description: "A wiki that should not pass validation because of a bare link.",
        space_id: space.id,
      },
    });

    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("malformed_wiki_links");
    expect((body as any).error.details.links[0].raw).toBe("[[Bare Link]]");
  });

  test("depth limit turns assign targets into non-queued placeholders", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-depth-space"));

    const content = [
      `Depth-limited assign [[assign:"Depth Assign ${uniqueName("x")}"|"should become placeholder"]].`,
    ].join("\n");

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content,
        label: "Depth Limit Wiki",
        keywords: ["depth test", "placeholder promotion"],
        short_description: "A wiki at max depth whose assign links should become placeholders.",
        space_id: space.id,
        depth: 2,
      },
    });

    expect(response.status).toBe(201);
    const created = body as any;
    expect(created.placeholders).toHaveLength(1);
    expect(created.placeholders.every((p: any) => p.status === "placeholder")).toBe(true);
    expect(created.wiki.properties.content).not.toContain("[[assign:");
    expect(created.wiki.properties.content.match(/\[\[entity:/g)).toHaveLength(1);

    for (const placeholder of created.placeholders) {
      const { response: phResponse, body: phBody } = await getJson(
        `/wiki/${placeholder.id}`,
        actor.apiKey,
      );
      expect(phResponse.status).toBe(200);
      expect((phBody as any).entity.type).toBe("placeholder");
      expect((phBody as any).entity.properties.status).toBe("placeholder");
    }
  });

  test("entity links to merged IDs are accepted and rewritten to canonical targets", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-redirect-space"));
    const target = await createEntity(actor.apiKey, "person", {
      label: uniqueName("wiki-redirect-target"),
    }, { space_id: space.id });
    const source = await createEntity(actor.apiKey, "person", {
      label: uniqueName("wiki-redirect-source"),
    }, { space_id: space.id });

    const { response: mergeResponse } = await jsonRequest(`/wiki/${target.id}/merge`, {
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
        label: "Redirect Wiki",
        keywords: ["redirect test", "merge follow"],
        short_description: "A wiki that references a merged entity to verify redirect canonicalization.",
        space_id: space.id,
      },
    });

    expect(response.status).toBe(201);
    const wiki = (body as any).wiki;
    expect(wiki.properties.content).toContain(`[[entity:${target.id}]]`);
    expect(wiki.properties.content).not.toContain(source.id);

    const { body: relBody } = await getJson(
      `/wiki/${wiki.id}/relationships?direction=out&target_id=${target.id}`,
      actor.apiKey,
    );
    expect((relBody as any).relationships.some((r: any) => r.target_id === target.id)).toBe(true);
  });

  test("concurrent submissions with the same label return one winner", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-concurrent-space"));

    const payload = {
      content: "Concurrent wiki with no secondary links.",
      label: "Concurrent Wiki",
      keywords: ["concurrency test"],
      short_description: "A wiki used to verify concurrent submissions are serialized by label.",
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

  test("duplicate detection matches aliases and folded accents", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-alias-space"));

    const first = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: "A page about mimetic theory and its author.",
        label: "René Girard",
        aliases: ["Rene Girard"],
        subject_type: "person",
        keywords: ["mimetic theory"],
        short_description: "French thinker known for mimetic theory and the scapegoat mechanism.",
        space_id: space.id,
      },
    });
    expect(first.response.status).toBe(201);

    const second = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: "A duplicate page using an unaccented spelling.",
        label: "Rene Girard",
        keywords: ["duplicate"],
        short_description: "Another attempted page for the same French thinker.",
        space_id: space.id,
      },
    });

    expect(second.response.status).toBe(409);
    expect((second.body as any).error.code).toBe("wiki_exists");
    expect((second.body as any).error.details.existing_wiki_id).toBe((first.body as any).wiki.id);
  });

  test("requires label, keywords, and short_description metadata", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-meta-space"));

    // Missing label
    {
      const { response, body } = await jsonRequest("/wiki", {
        method: "POST",
        apiKey: actor.apiKey,
        json: {
          content: "A wiki body with no typed links.",
          keywords: ["test"],
          short_description: "Ten or more characters of framing text.",
          space_id: space.id,
        },
      });
      expect(response.status).toBe(400);
      expect((body as any).error).toBeDefined();
    }

    // Empty keywords array
    {
      const { response } = await jsonRequest("/wiki", {
        method: "POST",
        apiKey: actor.apiKey,
        json: {
          content: "A wiki body with no typed links.",
          label: "Valid Label",
          keywords: [],
          short_description: "Ten or more characters of framing text.",
          space_id: space.id,
        },
      });
      expect(response.status).toBe(400);
    }

    // Short short_description
    {
      const { response } = await jsonRequest("/wiki", {
        method: "POST",
        apiKey: actor.apiKey,
        json: {
          content: "A wiki body with no typed links.",
          label: "Valid Label",
          keywords: ["valid"],
          short_description: "too short",
          space_id: space.id,
        },
      });
      expect(response.status).toBe(400);
    }
  });

  test("keywords and short_description are indexed and retrievable", async () => {
    const space = await createSpace(actor.apiKey, uniqueName("wiki-meta-index-space"));

    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: "Straightforward body with no typed links for this test.",
        label: "George Washington",
        subject_type: "person",
        aliases: ["Washington"],
        keywords: ["first president", "founding father", "Washington"],
        short_description: "American Founding Father and the first president of the United States.",
        space_id: space.id,
      },
    });

    expect(response.status).toBe(201);
    const wiki = (body as any).wiki;
    expect(wiki.properties.label).toBe("George Washington");
    expect(wiki.properties.subject_type).toBe("person");
    expect(wiki.properties.aliases).toEqual(["Washington"]);
    expect(wiki.properties.keywords).toContain("first president");
    expect(wiki.properties.keywords).toContain("founding father");
    expect(wiki.properties.short_description).toContain("Founding Father");
  });
});
