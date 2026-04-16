// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seed fixture for the manual end-to-end resolve test.
 *
 * Creates a fresh space populated with a curated set of entities/wikis
 * chosen to exercise boundary cases for the resolve pipeline: exact
 * matches, acronyms, polysemy, canonical-vs-variant, near-neighbors
 * that should NOT match, etc.
 *
 * Returned fixture object has one property per seeded item, keyed by
 * a stable logical name. Tests reference these by name so expectations
 * stay readable even as IDs change per run.
 */

import { createEntity, createSpace, jsonRequest, uniqueName } from "../e2e/helpers";

export interface ResolveFixture {
  spaceId: string;
  entities: {
    mattConnelly: string;
    williamSmith: string;
    drSmith: string;
    mercuryPlanet: string;
    mercuryElement: string;
    nato: string;
    bengalWiki: string;
    declassificationPolicyWiki: string;
  };
}

/**
 * Seed the resolve-test fixture into a fresh space. Requires a running
 * stack and an admin-level API key.
 */
export async function seedResolveTestFixtures(apiKey: string): Promise<ResolveFixture> {
  const space = await createSpace(apiKey, uniqueName("wiki-resolve-seed"));

  // --- Plain entities ---

  const mattConnelly = await createEntity(
    apiKey,
    "person",
    {
      label: "Matt Connelly",
      description: "Historian of secrecy and declassification at Columbia University.",
      keywords: ["Matthew Connelly", "Columbia professor"],
    },
    { space_id: space.id },
  );

  const williamSmith = await createEntity(
    apiKey,
    "person",
    {
      label: "William Smith",
      description: "British physician active in late-18th-century London.",
      keywords: ["Bill Smith", "W. Smith"],
    },
    { space_id: space.id },
  );

  // Intentional near-duplicate of williamSmith — the LLM should recognize the
  // overlap when resolving "William Smith" with ambiguous context, and we want
  // to confirm it reports BOTH IDs rather than silently collapsing.
  const drSmith = await createEntity(
    apiKey,
    "person",
    {
      label: "Dr. Smith",
      description: "British physician active in late-18th-century London.",
      keywords: ["Dr. William Smith"],
    },
    { space_id: space.id },
  );

  const mercuryPlanet = await createEntity(
    apiKey,
    "topic",
    {
      label: "Mercury",
      description: "The innermost planet of the solar system; smallest in the system.",
      keywords: ["planet Mercury", "innermost planet"],
    },
    { space_id: space.id },
  );

  const mercuryElement = await createEntity(
    apiKey,
    "topic",
    {
      label: "Mercury",
      description: "Chemical element with symbol Hg, a heavy silvery liquid metal at room temperature.",
      keywords: ["quicksilver", "Hg", "element Mercury"],
    },
    { space_id: space.id },
  );

  const nato = await createEntity(
    apiKey,
    "organization",
    {
      label: "NATO",
      description: "Intergovernmental military alliance founded in 1949.",
      keywords: ["North Atlantic Treaty Organization", "Atlantic Alliance"],
    },
    { space_id: space.id },
  );

  // --- Wikis (with the required metadata contract) ---

  const bengalWikiResp = await jsonRequest("/wiki", {
    method: "POST",
    apiKey,
    json: {
      content: "BENGAL is a framework for triaging classified documents for declassification review.",
      label: "BENGAL",
      keywords: ["BENGAL framework", "declassification triage", "Connelly framework"],
      short_description: "A framework for triaging classified documents for declassification review, developed by Matt Connelly's team.",
      primary_entities: [mattConnelly.id],
      space_id: space.id,
    },
  });
  if (bengalWikiResp.response.status !== 201) {
    throw new Error(
      `Seed failed on BENGAL wiki: ${bengalWikiResp.response.status} ${JSON.stringify(bengalWikiResp.body)}`,
    );
  }
  const bengalWiki = (bengalWikiResp.body as { wiki: { id: string } }).wiki.id;

  const policyWikiResp = await jsonRequest("/wiki", {
    method: "POST",
    apiKey,
    json: {
      content: "Classification policy governs how information is marked, handled, and eventually released.",
      label: "Classified Documents Policy",
      keywords: ["declassification policy", "information policy", "document classification"],
      short_description: "Category wiki covering government classification and declassification policy broadly — distinct from specific frameworks.",
      primary_entities: [williamSmith.id], // arbitrary — we just need a primary for the structural check
      space_id: space.id,
    },
  });
  if (policyWikiResp.response.status !== 201) {
    throw new Error(
      `Seed failed on policy wiki: ${policyWikiResp.response.status} ${JSON.stringify(policyWikiResp.body)}`,
    );
  }
  const declassificationPolicyWiki = (policyWikiResp.body as { wiki: { id: string } }).wiki.id;

  // Give Meilisearch a moment to catch up — indexing is async on the server side.
  await new Promise((r) => setTimeout(r, 2000));

  return {
    spaceId: space.id,
    entities: {
      mattConnelly: mattConnelly.id,
      williamSmith: williamSmith.id,
      drSmith: drSmith.id,
      mercuryPlanet: mercuryPlanet.id,
      mercuryElement: mercuryElement.id,
      nato: nato.id,
      bengalWiki,
      declassificationPolicyWiki,
    },
  };
}
