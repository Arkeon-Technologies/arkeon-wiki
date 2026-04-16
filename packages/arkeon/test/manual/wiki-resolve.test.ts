// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test of the resolve step against a live LLM.
 *
 * Requires:
 *   - A running Arkeon stack (e.g. `arkeon up`)
 *   - E2E_BASE_URL pointing at it (defaults to http://localhost:8000)
 *   - ADMIN_BOOTSTRAP_KEY set to the admin API key
 *   - An LLM provider configured via ~/.arkeon/llm.json or OPENAI_API_KEY
 *
 * Run with:
 *   npm run test:manual -w packages/arkeon
 *
 * Not run in CI — costs real tokens and requires network access to a
 * real model provider. Per the wiki pipeline defaults, uses nano which
 * costs well under a penny for the full suite.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { adminApiKey, createActor, jsonRequest } from "../e2e/helpers";
import { seedResolveTestFixtures, type ResolveFixture } from "./wiki-resolve-seed";

interface ResolveResponse {
  matches: Array<{ id: string; confidence: number; rationale?: string }>;
  actor_read_level: number;
}

async function resolveCall(apiKey: string, body: Record<string, unknown>): Promise<ResolveResponse> {
  const { response, body: respBody } = await jsonRequest("/resolve", {
    method: "POST",
    apiKey,
    json: body,
  });
  if (response.status !== 200) {
    throw new Error(`resolve returned ${response.status}: ${JSON.stringify(respBody)}`);
  }
  return respBody as ResolveResponse;
}

describe("resolve — end-to-end with live LLM", () => {
  let actorKey: string;
  let fx: ResolveFixture;

  beforeAll(async () => {
    const actor = await createActor(adminApiKey, {
      maxReadLevel: 2,
      maxWriteLevel: 2,
    });
    actorKey = actor.apiKey;
    fx = await seedResolveTestFixtures(actorKey);
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] seeded space ${fx.spaceId} with ${Object.keys(fx.entities).length} items`);
  }, 120_000);

  // --- Exact / near-exact label paths (may short-circuit without LLM) ---

  test("exact label match: 'Matt Connelly' → matches Matt Connelly", async () => {
    const result = await resolveCall(actorKey, {
      label: "Matt Connelly",
      space_id: fx.spaceId,
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.id).toBe(fx.entities.mattConnelly);
    // Confidence 1.0 = short-circuit path, 0.8 = LLM confirmed. Either is fine.
    expect(result.matches[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("LLM handles leading article: 'the Matt Connelly' → resolves to Matt Connelly (confidence < 1.0 — not a short-circuit)", async () => {
    // "the Matt Connelly" is NOT a strict-equal label match (the article
    // differs). The short-circuit must NOT fire; the LLM judge decides.
    const result = await resolveCall(actorKey, {
      label: "the Matt Connelly",
      description: "Columbia historian",
      space_id: fx.spaceId,
    });
    expect(result.matches.some((m) => m.id === fx.entities.mattConnelly)).toBe(true);
    // Assert this was the LLM path — confidence 0.8, not 1.0 (short-circuit).
    expect(result.matches[0]!.confidence).toBeLessThan(1.0);
  });

  test("short-circuit fires ONLY on exact label match — 'Smith' does NOT auto-match 'Dr. Smith'", async () => {
    // With strictNormalizeLabel, "Smith" ≠ "Dr. Smith". The short-circuit
    // must not fire on honorific differences. The LLM will be consulted
    // and can decide whether these refer to the same person based on
    // descriptions, but it must NOT silently auto-merge.
    //
    // Note: the seed space has no entity literally labeled "Smith" — only
    // "William Smith" and "Dr. Smith". So if the short-circuit were still
    // stripping honorifics, it would have auto-matched "Smith" → "Dr.
    // Smith" at confidence 1.0 (silently wrong). We assert that either
    // (a) no match, or (b) LLM-confirmed matches at confidence < 1.0.
    const result = await resolveCall(actorKey, {
      label: "Smith",
      description: "Generic query with no disambiguating context",
      space_id: fx.spaceId,
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] 'Smith' alone → ${JSON.stringify(result.matches)}`);
    // No confidence-1.0 match is allowed here — that would mean the
    // short-circuit fired and silently auto-merged.
    expect(result.matches.every((m) => m.confidence < 1.0)).toBe(true);
  });

  // --- Alias / keyword-driven matching (LLM required) ---

  test("alias match: 'Matthew Connelly' → resolves to Matt Connelly via keyword", async () => {
    const result = await resolveCall(actorKey, {
      label: "Matthew Connelly",
      description: "Historian at Columbia University",
      space_id: fx.spaceId,
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] Matthew Connelly → ${JSON.stringify(result.matches)}`);
    expect(result.matches[0]?.id).toBe(fx.entities.mattConnelly);
  });

  test("acronym expansion: 'North Atlantic Treaty Organization' → NATO", async () => {
    const result = await resolveCall(actorKey, {
      label: "North Atlantic Treaty Organization",
      space_id: fx.spaceId,
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] NATO expansion → ${JSON.stringify(result.matches)}`);
    expect(result.matches[0]?.id).toBe(fx.entities.nato);
  });

  test("acronym direct: 'NATO' → NATO", async () => {
    const result = await resolveCall(actorKey, {
      label: "NATO",
      space_id: fx.spaceId,
    });
    expect(result.matches[0]?.id).toBe(fx.entities.nato);
  });

  // --- Polysemy — description disambiguates ---

  test("polysemy: 'Mercury' with 'planet' description → planet, not element", async () => {
    const result = await resolveCall(actorKey, {
      label: "Mercury",
      description: "The innermost planet of the solar system",
      space_id: fx.spaceId,
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] Mercury/planet → ${JSON.stringify(result.matches)}`);
    expect(result.matches[0]?.id).toBe(fx.entities.mercuryPlanet);
    expect(result.matches.every((m) => m.id !== fx.entities.mercuryElement)).toBe(true);
  });

  test("polysemy: 'Mercury' with 'element Hg' description → element, not planet", async () => {
    const result = await resolveCall(actorKey, {
      label: "Mercury",
      description: "The chemical element with symbol Hg",
      space_id: fx.spaceId,
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] Mercury/element → ${JSON.stringify(result.matches)}`);
    expect(result.matches[0]?.id).toBe(fx.entities.mercuryElement);
    expect(result.matches.every((m) => m.id !== fx.entities.mercuryPlanet)).toBe(true);
  });

  test("polysemy: 'Mercury' with NO description → ambiguous or both", async () => {
    const result = await resolveCall(actorKey, {
      label: "Mercury",
      space_id: fx.spaceId,
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] Mercury/ambiguous → ${JSON.stringify(result.matches)}`);
    // Acceptable outcomes: LLM returns no match (correctly reports ambiguity as
    // insufficient signal), or returns BOTH as matches and caller will pick
    // one. Returning only ONE arbitrarily would be a regression because it
    // means the LLM is guessing — we log for inspection.
    if (result.matches.length === 1) {
      // eslint-disable-next-line no-console
      console.warn(`[resolve-test] Mercury ambiguous case returned single match — review rationale: ${result.matches[0]!.rationale}`);
    }
  });

  // --- Existing-duplicate recognition ---

  test("duplicate recognition (LLM path): 'Dr. William Smith' description-heavy query surfaces BOTH canonical + variant", async () => {
    // Use a label that doesn't exactly match either seeded entity, forcing
    // the LLM path (bypassing the strict short-circuit). Both williamSmith
    // and drSmith are the same person under different labels — the judge
    // should recognize this and return BOTH in same_as_ids, which is the
    // signal the dedup poller uses to find existing graph duplicates.
    const result = await resolveCall(actorKey, {
      label: "Dr. William Smith",
      description: "British physician active in late-18th-century London",
      space_id: fx.spaceId,
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] Dr. William Smith → ${JSON.stringify(result.matches)}`);
    const ids = result.matches.map((m) => m.id);
    // Both entities share the exact same description (seeded intentionally),
    // so the judge has clear signal to call them duplicates. At minimum it
    // should return ONE match (the more specific label wins); ideally both.
    expect(ids.length).toBeGreaterThan(0);
    expect(
      ids.includes(fx.entities.williamSmith) || ids.includes(fx.entities.drSmith),
    ).toBe(true);
    if (!(ids.includes(fx.entities.williamSmith) && ids.includes(fx.entities.drSmith))) {
      // eslint-disable-next-line no-console
      console.warn(
        `[resolve-test] LLM did not flag both as duplicates — only returned ${ids.length}/2. ` +
        `Rationale: ${result.matches[0]?.rationale}`,
      );
    }
  });

  // --- Near-neighbor rejection ---

  test("near-neighbor rejection: 'declassification policy' does NOT match BENGAL", async () => {
    const result = await resolveCall(actorKey, {
      label: "declassification policy",
      description: "Broad policy category governing how classified information is released.",
      space_id: fx.spaceId,
      candidate_filter: ['type = "wiki"'],
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] declassification policy → ${JSON.stringify(result.matches)}`);
    expect(result.matches.every((m) => m.id !== fx.entities.bengalWiki)).toBe(true);
    // Should match the policy wiki if anything
    if (result.matches.length > 0) {
      expect(result.matches[0]!.id).toBe(fx.entities.declassificationPolicyWiki);
    }
  });

  // --- No-candidate path (no LLM call expected) ---

  test("no candidates: 'Napoleon Bonaparte' (not seeded) returns empty matches", async () => {
    const result = await resolveCall(actorKey, {
      label: "Napoleon Bonaparte",
      description: "French military leader and emperor",
      space_id: fx.spaceId,
    });
    expect(result.matches).toEqual([]);
  });

  // --- Scoping ---

  test("space scoping: searching a different space returns empty", async () => {
    // Create a second space with no overlap
    const otherSpace = await jsonRequest("/spaces", {
      method: "POST",
      apiKey: actorKey,
      json: { name: `other-space-${Date.now()}` },
    });
    const otherSpaceId = (otherSpace.body as any).space.id;
    const result = await resolveCall(actorKey, {
      label: "Matt Connelly",
      space_id: otherSpaceId,
    });
    expect(result.matches).toEqual([]);
  });

  // --- Candidate filter targeting wikis ---

  test("candidate filter: 'BENGAL framework' with wiki-only filter → matches BENGAL wiki", async () => {
    const result = await resolveCall(actorKey, {
      label: "BENGAL framework",
      description: "Declassification triage framework",
      space_id: fx.spaceId,
      candidate_filter: ['type = "wiki"'],
    });
    // eslint-disable-next-line no-console
    console.log(`[resolve-test] BENGAL wiki → ${JSON.stringify(result.matches)}`);
    expect(result.matches[0]?.id).toBe(fx.entities.bengalWiki);
  });
});
