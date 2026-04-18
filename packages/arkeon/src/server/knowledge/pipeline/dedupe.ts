// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-write deduplication: per-entity search + LLM judge, then rectify.
 *
 * Algorithm:
 * 1. For each entity, search Meilisearch (label-only) for candidates
 * 2. LLM judges each entity against its direct candidates: "same or different?"
 * 3. Rectify: union-find on all LLM-confirmed merges to consolidate overlapping groups
 *    (if A=B from one judgment and B=C from another, they become {A,B,C})
 * 4. Merge: execute each rectified group sequentially
 */

import { LlmClient } from "../lib/llm";
import { search, getEntity, post } from "../lib/arke-client";
import type { EntityCandidate } from "../lib/types";
import type { LlmUsage } from "../lib/llm";
import { normalizeLabel as normalize } from "../lib/normalize";

// ---------------------------------------------------------------------------
// Union-find for rectification
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  components(): Map<string, Set<string>> {
    const groups = new Map<string, Set<string>>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root)!.add(id);
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// Stop words & query building
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an",
  "of", "in", "on", "at", "to", "for", "from", "with", "by", "into",
  "through", "during", "before", "after", "above", "below", "between",
  "under", "over", "about", "against", "among", "upon", "within",
  "and", "or", "but", "nor", "yet", "so",
  "is", "was", "are", "were", "be", "been", "being",
  "has", "had", "have", "having",
  "do", "does", "did",
  "that", "this", "these", "those", "it", "its",
  "he", "she", "they", "we", "his", "her", "their", "our",
  "as", "if", "not", "no", "all", "also", "more", "most", "very",
  "which", "who", "whom", "whose", "when", "where", "how", "what",
]);

function buildQueries(label: string): string[] {
  const normalized = normalize(label);
  const parts = normalized.split(" ").filter(Boolean);
  const queries = new Set<string>([label, normalized]);
  for (const part of parts) {
    if (!STOP_WORDS.has(part)) queries.add(part);
  }
  return [...queries].filter(Boolean).slice(0, 10);
}

// ---------------------------------------------------------------------------
// LLM prompt — judges one entity against its direct candidates
// ---------------------------------------------------------------------------

const DEDUPE_PROMPT = `You are an entity merge judge for a knowledge graph.

Given one entity and a set of candidates, decide which candidates refer to the same real-world entity and should be merged.

Return JSON:
{
  "same_as_ids": ["01CAND1"],
  "different_ids": ["01OTHER"],
  "rationale": "short explanation"
}

Rules:
- MERGE when candidates clearly refer to the same real-world entity, even if labels differ (e.g. "William Smith" = "Dr. Smith" = "W. Smith" — same person, different name forms)
- Use descriptions to confirm identity — if descriptions reference the same roles, events, or attributes, they are likely the same entity
- Keep SEPARATE when candidates are genuinely different entities that happen to share a name (e.g. a person vs an organization, or father vs son, or "Mercury" the planet vs "Mercury" the element)
- Keep SEPARATE when one is an event/action ABOUT an entity (e.g. "Smith appointed as Director" ≠ "National Museum")
- Type is a hint, not absolute — the same entity may have been typed differently
- Exclude the entity itself from results
- If uncertain and descriptions are too sparse to confirm, put the candidate in different_ids — false merges are irreversible and worse than missed merges`;

const MAX_DESC_CHARS = 200;
const SKIP_TYPES = new Set(["document", "text_chunk"]);

// ---------------------------------------------------------------------------
// Per-entity: search for candidates and judge
// ---------------------------------------------------------------------------

async function dedupeOne(
  llm: LlmClient,
  entityId: string,
  spaceId?: string,
): Promise<{
  mergeIds?: string[];
  rationale?: string;
  usage?: LlmUsage;
}> {
  const entity = await getEntity(entityId);
  if (!entity) return {};

  const label = entity.properties?.label ?? "";
  if (!label) return {};
  if (SKIP_TYPES.has(entity.type)) return {};

  const queries = buildQueries(label);
  const hits = new Map<string, EntityCandidate>();

  for (const q of queries) {
    const results = await search(q, { space_id: spaceId, limit: 20, search_on: "label" });
    for (const hit of results) {
      if (hit.id && hit.id !== entityId && !hits.has(hit.id)) {
        const full = await getEntity(hit.id);
        if (!full) continue;
        if (full.kind === "relationship") continue;
        if (SKIP_TYPES.has(full.type)) continue;
        const candidateLabel = full?.properties?.label ?? "";
        if (normalize(candidateLabel) !== "") {
          const desc = full?.properties?.description ?? "";
          hits.set(hit.id, {
            id: hit.id,
            label: candidateLabel,
            type: full?.type ?? "",
            description: typeof desc === "string" ? desc.slice(0, MAX_DESC_CHARS) : "",
          });
        }
      }
    }
  }

  const candidates = [...hits.values()].slice(0, 20);
  if (candidates.length === 0) return {};

  // Exact normalized-label matches — always merge regardless of type (target's type wins)
  const normalizedSelf = normalize(label);
  const exactMatches = candidates.filter((c) => normalize(c.label) === normalizedSelf);
  const nonExact = candidates.filter((c) => normalize(c.label) !== normalizedSelf);

  if (exactMatches.length > 0) {
    console.log(`[knowledge:dedupe] "${label}" — exact match: ${exactMatches.map((c) => `"${c.label}" (${c.type})`).join(", ")}`);
  }

  if (nonExact.length === 0) {
    // All candidates are exact matches — no LLM needed
    if (exactMatches.length > 0) {
      return { mergeIds: exactMatches.map((c) => c.id), rationale: `Exact label match` };
    }
    return {};
  }

  // LLM judge — only for non-exact candidates
  const result = await llm.chatJson<{
    same_as_ids?: string[];
    different_ids?: string[];
    rationale?: string;
  }>(
    DEDUPE_PROMPT,
    JSON.stringify({
      self: {
        id: entityId,
        label,
        type: entity.type,
        description: typeof entity.properties?.description === "string"
          ? entity.properties.description.slice(0, MAX_DESC_CHARS) : "",
      },
      candidates: nonExact,
    }),
    { maxTokens: 1200 },
  );

  const llmSameIds = (result.data.same_as_ids ?? []).filter((id) => id !== entityId);
  const rationale = result.data.rationale ?? "";

  if (llmSameIds.length > 0) {
    console.log(`[knowledge:dedupe] "${label}" — LLM merge with: ${llmSameIds.map((id) => `"${hits.get(id)?.label ?? id}"`).join(", ")} — ${rationale}`);
  }

  // Combine exact-label matches with LLM-confirmed matches
  const exactIds = exactMatches.map((c) => c.id);
  const allMergeIds = [...exactIds, ...llmSameIds];
  const allRationales = [
    ...(exactIds.length > 0 ? ["Exact label match"] : []),
    ...(llmSameIds.length > 0 ? [rationale] : []),
  ].join("; ");

  return {
    mergeIds: allMergeIds.length > 0 ? allMergeIds : undefined,
    rationale: allMergeIds.length > 0 ? allRationales : undefined,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Main dedupe function
// ---------------------------------------------------------------------------

export async function dedupeEntities(
  llm: LlmClient,
  entityIds: string[],
  spaceId?: string,
  _opts?: { concurrency?: number },
): Promise<{
  duplicates: Array<{ entityId: string; duplicateIds: string[]; rationale: string }>;
  usage: LlmUsage[];
}> {
  // Wait for Meilisearch indexing
  await new Promise((r) => setTimeout(r, 3000));

  console.log(`[knowledge:dedupe] Deduping ${entityIds.length} entities (per-entity search + judge)`);

  // Step 1+2: Per-entity search and LLM judge
  const allUsage: LlmUsage[] = [];
  const confirmedPairs: Array<{ entityId: string; mergeIds: string[]; rationale: string }> = [];

  for (const entityId of entityIds) {
    try {
      const result = await dedupeOne(llm, entityId, spaceId);
      if (result.mergeIds && result.mergeIds.length > 0) {
        confirmedPairs.push({
          entityId,
          mergeIds: result.mergeIds,
          rationale: result.rationale ?? "",
        });
      }
      if (result.usage) allUsage.push(result.usage);
    } catch (err) {
      console.warn(`[knowledge:dedupe] Failed for ${entityId}, skipping:`, err instanceof Error ? err.message : err);
    }
  }

  if (confirmedPairs.length === 0) {
    console.log(`[knowledge:dedupe] No duplicates confirmed`);
    return { duplicates: [], usage: allUsage };
  }

  // Step 3: Rectify — union-find on all confirmed merges to consolidate
  // overlapping groups. If entity A matched B, and entity B matched C,
  // they become one group {A, B, C}.
  const uf = new UnionFind();
  for (const pair of confirmedPairs) {
    for (const mergeId of pair.mergeIds) {
      uf.union(pair.entityId, mergeId);
    }
  }

  const rectified = uf.components();
  const finalGroups = [...rectified.values()].filter((s) => s.size >= 2);

  console.log(`[knowledge:dedupe] ${confirmedPairs.length} confirmed pairs → rectified into ${finalGroups.length} merge group(s)`);

  const duplicates = finalGroups.map((group) => {
    const ids = [...group];
    const pair = confirmedPairs.find((p) => group.has(p.entityId));
    return {
      entityId: ids[0],
      duplicateIds: ids.slice(1),
      rationale: pair?.rationale ?? "Rectified merge",
    };
  });

  return { duplicates, usage: allUsage };
}

// ---------------------------------------------------------------------------
// Execute merges
// ---------------------------------------------------------------------------

export async function mergeConfirmedDuplicates(
  duplicates: Array<{ entityId: string; duplicateIds: string[]; rationale: string }>,
): Promise<{ merged: number; failed: number }> {
  if (duplicates.length === 0) return { merged: 0, failed: 0 };

  let merged = 0;
  let failed = 0;

  for (const d of duplicates) {
    const group = { entity_ids: [d.entityId, ...d.duplicateIds] };
    try {
      const result = (await post("/entities/merge-batch", {
        groups: [group],
        property_strategy: "accumulate",
      })) as { merged: number; failed: number };
      merged += result.merged ?? 0;
      failed += result.failed ?? 0;
    } catch {
      failed++;
    }
  }

  if (merged > 0) {
    console.log(`[knowledge:dedupe] Auto-merged ${merged} duplicate(s)`);
  }
  return { merged, failed };
}
