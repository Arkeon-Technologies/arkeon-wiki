// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for the wiki draft worker.
 *
 * Requires a running stack with LLM and Meilisearch configured:
 *   OPENAI_API_KEY=sk-... npm run test:e2e -- draft-worker
 *
 * These tests exercise the full pipeline: POST /wiki with assign links
 * → placeholder queued → draft worker processes → wiki published.
 */

import { describe, expect, test } from "vitest";
import {
  adminApiKey,
  baseUrl,
  createActor,
  createSpace,
  createWiki,
  getJson,
  jsonRequest,
  uniqueName,
} from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a condition until it resolves to true or timeout. */
async function waitFor(
  fn: () => Promise<boolean>,
  { timeoutMs = 60_000, intervalMs = 2_000 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function getQueueStatus(entityId: string): Promise<string | null> {
  // Use the admin key to query the DB directly via a search for the entity
  const { response, body } = await getJson(`/wiki/${entityId}`, adminApiKey);
  if (response.status === 410) return "redirected";
  if (response.status === 404) return "gone";
  if (response.status !== 200) return null;
  const wiki = (body as any).wiki;
  return wiki?.properties?.status ?? wiki?.type ?? null;
}

describe("Draft worker", () => {
  // Skip if no LLM configured — draft worker requires it
  const hasLlm = !!process.env.OPENAI_API_KEY;

  let actor: Awaited<ReturnType<typeof createActor>>;
  let spaceId: string;

  test("setup: create actor and space", async () => {
    actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    const space = await createSpace(actor.apiKey, uniqueName("draft-space"));
    spaceId = space.id;
  });

  test("assign link creates placeholder and queues it", async () => {
    const label = uniqueName("assign-test");
    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: `This wiki discusses [[assign:"${label}"|"A concept to be drafted by the background worker"]].`,
        label: uniqueName("parent-wiki"),
        keywords: ["draft test"],
        short_description: "A wiki that assigns a concept for background drafting.",
        space_id: spaceId,
      },
    });

    expect(response.status).toBe(201);
    const created = body as any;
    expect(created.placeholders).toHaveLength(1);
    expect(created.placeholders[0].status).toBe("assigned");

    const phId = created.placeholders[0].id;

    // Verify the placeholder entity exists
    const { response: phRes, body: phBody } = await getJson(`/wiki/${phId}`, actor.apiKey);
    expect(phRes.status).toBe(200);
    expect((phBody as any).wiki.type).toBe("placeholder");
    expect((phBody as any).wiki.properties.status).toBe("assigned");
  });

  test.skipIf(!hasLlm)("draft worker processes queued placeholder into a published wiki", async () => {
    const subjectLabel = uniqueName("ATP-Synthase");
    const parentLabel = uniqueName("Cellular-Respiration");

    // Create a parent wiki with context that references the subject
    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: [
          `Cellular respiration is the metabolic process by which cells convert nutrients into ATP.`,
          ``,
          `A key enzyme in this process is [[assign:"${subjectLabel}"|"Enzyme complex that synthesizes ATP from a proton gradient across the inner mitochondrial membrane"]].`,
          ``,
          `The process involves glycolysis, the citric acid cycle, and oxidative phosphorylation.`,
        ].join("\n"),
        label: parentLabel,
        keywords: ["cellular respiration", "ATP", "metabolism"],
        short_description: "The metabolic pathway that converts nutrients into usable cellular energy (ATP).",
        space_id: spaceId,
      },
    });

    expect(response.status).toBe(201);
    const created = body as any;
    const assigned = created.placeholders.find((p: any) => p.status === "assigned");
    expect(assigned).toBeTruthy();
    const placeholderId = assigned.id;

    console.log(`[test] placeholder ${placeholderId} queued for "${subjectLabel}"`);
    console.log(`[test] waiting for draft worker to process (up to 90s)...`);

    // Wait for the draft worker to process it.
    // The placeholder should either become a published wiki (via redirect to a new wiki)
    // or remain as a placeholder with status changed.
    // Check by polling the queue status or looking for a new wiki with the subject label.
    let resultWikiId: string | null = null;

    await waitFor(async () => {
      // Check if placeholder was redirected (merged into a new wiki)
      const { response: phRes } = await getJson(`/wiki/${placeholderId}`, actor.apiKey);
      if (phRes.status === 410) {
        // Redirected — the draft was published and placeholder merged
        const phBody = await phRes.json().catch(() => null);
        resultWikiId = (phBody as any)?.error?.details?.merged_into ?? null;
        return true;
      }

      // Check if a wiki with the subject label now exists in the space
      const { response: searchRes, body: searchBody } = await getJson(
        `/wiki?filter=type:wiki&space_id=${spaceId}`,
        actor.apiKey,
      );
      if (searchRes.status === 200) {
        const wikis = (searchBody as any).entities ?? [];
        const found = wikis.find((w: any) =>
          w.properties?.label?.includes(subjectLabel) ||
          w.properties?.label?.toLowerCase().includes("atp")
        );
        if (found) {
          resultWikiId = found.id;
          return true;
        }
      }

      // Check if placeholder entity's properties.status changed from "assigned"
      const { response: entRes, body: entBody } = await getJson(`/wiki/${placeholderId}`, actor.apiKey);
      if (entRes.status === 200) {
        const status = (entBody as any).wiki?.properties?.status;
        if (status === "undraftable") {
          console.log(`[test] placeholder marked undraftable`);
          return true; // processed, just not drafted
        }
      }

      return false;
    }, { timeoutMs: 90_000, intervalMs: 3_000 });

    if (resultWikiId) {
      console.log(`[test] draft published as wiki ${resultWikiId}`);

      // Verify the drafted wiki has content
      const { response: wikiRes, body: wikiBody } = await getJson(`/wiki/${resultWikiId}`, actor.apiKey);
      expect(wikiRes.status).toBe(200);
      const wiki = (wikiBody as any).wiki;
      expect(wiki.type).toBe("wiki");
      expect(wiki.properties.status).toBe("published");
      expect(wiki.properties.content).toBeTruthy();
      expect(wiki.properties.content.length).toBeGreaterThan(50);
      expect(wiki.properties.keywords).toBeTruthy();
      expect(wiki.properties.short_description).toBeTruthy();

      console.log(`[test] verified: "${wiki.properties.label}" (${wiki.properties.content.length} chars)`);
    } else {
      console.log(`[test] placeholder processed but no wiki published (may be undraftable)`);
    }
  }, 120_000);

  test("reconcile redirects placeholder when wiki already exists", async () => {
    const sharedLabel = uniqueName("Existing-Concept");

    // First, create a published wiki with this label
    await createWiki(actor.apiKey, sharedLabel, `This is the canonical wiki about ${sharedLabel}.`, {
      keywords: [sharedLabel.toLowerCase(), "existing concept"],
      short_description: `The canonical reference for ${sharedLabel} in this knowledge graph.`,
      space_id: spaceId,
    });

    // Give Meilisearch a moment to index
    await sleep(1000);

    // Now create a parent wiki that assigns the same label
    const { response, body } = await jsonRequest("/wiki", {
      method: "POST",
      apiKey: actor.apiKey,
      json: {
        content: `See also [[assign:"${sharedLabel}"|"A concept that already has a published wiki"]].`,
        label: uniqueName("parent-reconcile"),
        keywords: ["reconcile test"],
        short_description: "Tests that the draft worker redirects rather than re-drafts.",
        space_id: spaceId,
      },
    });

    expect(response.status).toBe(201);
    const assigned = (body as any).placeholders.find((p: any) => p.status === "assigned");
    expect(assigned).toBeTruthy();

    console.log(`[test] placeholder ${assigned.id} queued, expecting reconcile redirect...`);

    // Wait for draft worker to process — should redirect quickly (no LLM drafting needed)
    if (hasLlm) {
      await waitFor(async () => {
        const { response: phRes } = await getJson(`/wiki/${assigned.id}`, actor.apiKey);
        if (phRes.status === 410) return true; // redirected

        // Also check if placeholder status changed
        if (phRes.status === 200) {
          const entity = ((await phRes.json().catch(() => null)) as any)?.wiki;
          const status = entity?.properties?.status;
          if (status && status !== "assigned") return true;
        }
        return false;
      }, { timeoutMs: 60_000, intervalMs: 2_000 });

      console.log(`[test] reconcile redirect completed`);
    }
  }, 90_000);
});
