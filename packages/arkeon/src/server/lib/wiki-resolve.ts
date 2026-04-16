// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve [[resolve:...]] links via Meilisearch blocking + LLM
 * multiple-choice disambiguation.
 *
 * Pipeline per link:
 *   1. Search Meilisearch for candidate entities by label + description
 *   2. If zero candidates → no match
 *   3. If one high-confidence candidate → auto-resolve
 *   4. If multiple → LLM multiple-choice picks the best or "none"
 */

import OpenAI from "openai";
import type { ParsedLink } from "./wiki-links";
import { searchEntities, isMeilisearchConfigured } from "./meilisearch";
import { createSql, withTransaction } from "./sql";
import { setActorContext } from "./actor-context";
import type { Actor } from "../types";

export interface ResolvedLink {
  link: ParsedLink;
  /** The matched entity ID, or null if no match found */
  entityId: string | null;
  /** Match confidence 0-1. 1.0 = auto-resolved, <1.0 = LLM-assisted */
  confidence: number;
}

interface EntityCandidate {
  id: string;
  type: string;
  label: string;
  description: string;
}

let _llm: OpenAI | null = null;

function getWikiLlmClient(): OpenAI {
  if (_llm) return _llm;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for wiki link resolution. " +
      "Set it in the environment or via arkeon init --llm-api-key.",
    );
  }
  _llm = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });
  return _llm;
}

/**
 * Resolve a batch of resolve: links against Meilisearch + LLM.
 *
 * Returns one ResolvedLink per input. Links with entityId=null
 * should be treated as draft/gap by the caller.
 */
export async function resolveLinks(
  links: ParsedLink[],
  actor: Actor,
  spaceId?: string,
): Promise<ResolvedLink[]> {
  if (links.length === 0) return [];

  const results: ResolvedLink[] = [];

  for (const link of links) {
    const searchQuery = [link.label, link.description].filter(Boolean).join(" ");

    // Step 1: Meilisearch blocking search
    const filters: string[] = ['kind = "entity"'];
    if (spaceId) {
      filters.push(`space_ids = "${spaceId}"`);
    }
    // Only return entities the actor can read
    filters.push(`read_level <= ${actor.maxReadLevel}`);

    let candidateIds: string[] = [];
    if (isMeilisearchConfigured()) {
      const searchResult = await searchEntities(searchQuery, {
        filter: filters,
        limit: 5,
      });
      candidateIds = searchResult.ids;
    }

    if (candidateIds.length === 0) {
      results.push({ link, entityId: null, confidence: 0 });
      continue;
    }

    // Step 2: Fetch candidate details from Postgres
    const candidates = await fetchCandidates(candidateIds, actor);

    if (candidates.length === 0) {
      results.push({ link, entityId: null, confidence: 0 });
      continue;
    }

    // Step 3: If only one candidate, auto-resolve
    if (candidates.length === 1) {
      results.push({ link, entityId: candidates[0]!.id, confidence: 1.0 });
      continue;
    }

    // Step 4: LLM multiple-choice disambiguation
    const resolved = await llmDisambiguate(link, candidates);
    results.push(resolved);
  }

  return results;
}

async function fetchCandidates(
  ids: string[],
  actor: Actor,
): Promise<EntityCandidate[]> {
  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;

    const rows = await sql`
      SELECT id, type, properties
      FROM entities
      WHERE id = ANY(${ids})
        AND kind = 'entity'
      LIMIT 5
    `;

    return rows.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      label: String((r.properties as Record<string, unknown>)?.label ?? ""),
      description: String((r.properties as Record<string, unknown>)?.description ?? ""),
    }));
  });
}

async function llmDisambiguate(
  link: ParsedLink,
  candidates: EntityCandidate[],
): Promise<ResolvedLink> {
  const model = process.env.WIKI_RESOLVE_MODEL ?? "gpt-4o-mini";
  const llm = getWikiLlmClient();

  const letters = ["A", "B", "C", "D", "E"];
  const choiceList = candidates
    .map((c, i) => `${letters[i]}) ${c.label} (${c.type}) — ${c.description || "no description"}`)
    .join("\n");

  const prompt = `You are resolving an entity reference in a knowledge wiki.

The author wrote a link to: "${link.label}"${link.description ? ` described as "${link.description}"` : ""}

Context from the surrounding text:
"${link.spanText}"

Which of the following existing entities is this referring to?

${choiceList}
${letters[candidates.length]}) None of the above — this is a distinct entity not listed here.

Respond with ONLY a JSON object: {"choice": "<letter>", "justification": "<one sentence>"}`;

  try {
    const response = await llm.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 150,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { link, entityId: null, confidence: 0 };
    }

    const parsed = JSON.parse(content) as { choice?: string; justification?: string };
    const choice = parsed.choice?.toUpperCase();

    if (!choice || choice === "NONE" || choice === letters[candidates.length]) {
      return { link, entityId: null, confidence: 0 };
    }

    const idx = letters.indexOf(choice);
    if (idx >= 0 && idx < candidates.length) {
      return { link, entityId: candidates[idx]!.id, confidence: 0.8 };
    }

    return { link, entityId: null, confidence: 0 };
  } catch (err) {
    console.error("[wiki-resolve] LLM disambiguation failed:", err);
    return { link, entityId: null, confidence: 0 };
  }
}
