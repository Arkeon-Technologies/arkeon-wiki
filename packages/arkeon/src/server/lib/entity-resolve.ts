// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable "find matching entities" primitive for the wiki pipeline.
 *
 * Same pattern is used in three places:
 *
 *   resolve  — one call per [[resolve:...]] link in a wiki body.
 *              Subject = link's label+description+surrounding prose.
 *              Candidates = all entities in the workspace.
 *              Caller (wiki-resolve.ts) translates match → entity link.
 *
 *   exists   — one call before each draft the draft worker writes.
 *              Subject = placeholder's label+description+inbound spans.
 *              Candidates = published wikis in the workspace.
 *              Caller (wiki-exists.ts, Phase 2a) translates match →
 *              redirect placeholder to existing wiki, skip drafting.
 *
 *   dedup    — one call per newly-published wiki.
 *              Subject = new wiki's label+keywords+short_description.
 *              Candidates = other published wikis.
 *              Caller (wiki-dedup.ts, Phase 2b) translates match → merge.
 *
 * The primitive handles:
 *   1. Deterministic query generation from the subject (label tokens +
 *      keywords + normalized phrases). No LLM query generation — the
 *      subject's own metadata is the query seed.
 *   2. Multi-query Meilisearch with union to build a candidate pool.
 *      Each query is narrowed to the searchAttributes so ranking is
 *      label/keywords/short_description-driven, not content-driven.
 *   3. Exact normalized-label short-circuit — no LLM needed when a
 *      candidate's label normalizes to the same string as the target.
 *   4. Single LLM judge call over the full candidate pool, returning
 *      same_as_ids / different_ids. Multiple matches imply existing
 *      duplicates in the graph — the dedup poller cleans up.
 */

import { searchEntities, isMeilisearchConfigured } from "./meilisearch";
import { withTransaction } from "./sql";
import { setActorContext } from "./actor-context";
import { getLlmClient, type LlmStep } from "./llm";
import { buildCandidateQueries, strictNormalizeLabel } from "./label-match";
import type { Actor } from "../types";

export interface ResolutionSubject {
  /** Canonical name of the thing we're trying to match. Required. */
  label: string;
  /** Free-form description. Used both for query generation and as LLM context. */
  description?: string;
  /** Author-chosen alternate names / search phrasings. Used as queries and LLM context. */
  keywords?: string[];
  /** Surrounding prose (span text, inbound spans, etc.) — fed to the LLM as disambiguation context only, never used as a query. */
  context?: string;
}

export interface ResolutionOptions {
  actor: Actor;
  /** Which workspace to search within. Omit for global. */
  spaceId?: string;
  /** Meilisearch filters in addition to kind/read_level/space_ids.
   *  E.g. ['type = "wiki"'] to restrict candidates to wikis. */
  candidateFilter?: string[];
  /** Attributes to search against. Defaults to the wiki-metadata set
   *  (works for both wikis and plain entities — entities without
   *  keywords/short_description fall through to label). */
  searchAttributes?: string[];
  /** Max candidate pool size across all queries. Default 20. */
  poolCap?: number;
  /** Which LLM step's config to use for judgment. Default "resolve". */
  llmStep?: LlmStep;
}

export interface EntityMatch {
  /** Matched entity ID. */
  id: string;
  /** 1.0 = exact normalized-label match; 0.8 = LLM-confirmed; 0 = no match. */
  confidence: number;
  /** Short explanation from the LLM judge (or short-circuit reason). */
  rationale?: string;
}

export interface Candidate {
  id: string;
  type: string;
  label: string;
  description: string;
  keywords?: string[];
  short_description?: string;
}

const DEFAULT_POOL_CAP = 20;
const DEFAULT_SEARCH_ATTRS = ["label", "keywords", "short_description"];
const DESC_SNIPPET_CHARS = 200;
const SHORT_DESC_SNIPPET_CHARS = 300;

/**
 * Find entities in the graph that refer to the same subject as the input.
 *
 * Returns ALL LLM-confirmed matches in rank order. Most callers take
 * only the first (highest-rank match); the dedup caller wants the full
 * list because it needs to know about existing duplicates.
 *
 * Returns [] if Meilisearch is unconfigured, the subject label is
 * empty, no candidates surface, or the LLM judge rejects them all.
 */
export async function findSimilarEntities(
  subject: ResolutionSubject,
  options: ResolutionOptions,
): Promise<EntityMatch[]> {
  if (!isMeilisearchConfigured()) return [];
  if (!subject.label || !subject.label.trim()) return [];

  const poolCap = options.poolCap ?? DEFAULT_POOL_CAP;
  const searchAttrs = options.searchAttributes ?? DEFAULT_SEARCH_ATTRS;
  const llmStep: LlmStep = options.llmStep ?? "resolve";

  // --- Query generation ---
  const queries = buildCandidateQueries(subject.label, subject.description, subject.keywords);
  if (queries.length === 0) return [];

  // --- Filter assembly ---
  const filters: string[] = [
    'kind = "entity"',
    `read_level <= ${Number(options.actor.maxReadLevel)}`,
  ];
  if (options.spaceId) filters.push(`space_ids = "${options.spaceId}"`);
  if (options.candidateFilter) filters.push(...options.candidateFilter);

  // --- Meilisearch union ---
  const hitIds = new Set<string>();
  for (const q of queries) {
    if (hitIds.size >= poolCap) break;
    try {
      const result = await searchEntities(q, {
        filter: filters,
        limit: 20,
        attributesToSearchOn: searchAttrs,
      });
      for (const id of result.ids) {
        hitIds.add(id);
        if (hitIds.size >= poolCap) break;
      }
    } catch (err) {
      console.warn(`[entity-resolve] Meilisearch query failed for "${q}":`, (err as Error).message);
    }
  }
  if (hitIds.size === 0) return [];

  const candidates = await fetchCandidates([...hitIds], options.actor);
  if (candidates.length === 0) return [];

  // --- Exact-label short-circuit (strict equality, case/whitespace only) ---
  //
  // We deliberately do NOT strip articles or honorifics here — "Smith" and
  // "Dr. Smith" might be the same person, or might not, and that's a
  // judgment call that belongs to the LLM with its full disambiguation
  // context. The short-circuit only fires when the target's label is the
  // SAME string as a candidate's label, modulo case + whitespace.
  const strictTarget = strictNormalizeLabel(subject.label);
  if (strictTarget) {
    const exact = candidates.filter((c) => strictNormalizeLabel(c.label) === strictTarget);
    if (exact.length === 1) {
      return [{ id: exact[0]!.id, confidence: 1.0, rationale: "Exact label match" }];
    }
    // Two or more identical labels fall through to the LLM — the graph has
    // duplicates (or polysemy like "Mercury" planet vs. element), and the
    // judge's disambiguation is exactly what's needed. Zero matches also
    // falls through in case the LLM can find a match via keywords or
    // short_description that the label-only exact check missed.
  }

  // --- LLM judge ---
  return await llmJudge(subject, candidates, llmStep);
}

async function fetchCandidates(ids: string[], actor: Actor): Promise<Candidate[]> {
  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;

    const rows = await sql`
      SELECT id, type, properties
      FROM entities
      WHERE id = ANY(${ids})
        AND kind = 'entity'
    `;

    const byId = new Map<string, Candidate>();
    for (const r of rows) {
      const props = (r.properties as Record<string, unknown>) ?? {};
      const label = String(props.label ?? "");
      if (!label) continue;
      const description = String(props.description ?? "");
      const shortDesc = String(props.short_description ?? "");
      const kw = Array.isArray(props.keywords)
        ? props.keywords.filter((x): x is string => typeof x === "string")
        : undefined;
      byId.set(String(r.id), {
        id: String(r.id),
        type: String(r.type),
        label,
        description: description.slice(0, DESC_SNIPPET_CHARS),
        short_description: shortDesc ? shortDesc.slice(0, SHORT_DESC_SNIPPET_CHARS) : undefined,
        keywords: kw,
      });
    }

    // Preserve Meilisearch rank order.
    return ids.map((id) => byId.get(id)).filter((c): c is Candidate => Boolean(c));
  });
}

const JUDGE_PROMPT = `You are an entity reference judge for a knowledge wiki.

You'll receive one "target" and a list of candidate entities from the
graph. Identify which candidates (if any) are the SAME real-world
entity/subject as the target.

Return JSON:
{
  "same_as_ids": ["01ABC"],
  "different_ids": ["01XYZ"],
  "rationale": "short explanation"
}

Rules:
- MATCH when a candidate clearly refers to the same real-world entity
  as the target, even if labels differ ("William Smith" = "Dr. Smith"
  = "W. Smith"; "NATO" = "North Atlantic Treaty Organization").
- Use the target's description, keywords, and surrounding context to
  disambiguate — same description content or keyword overlap is strong
  evidence of a match.
- Keep SEPARATE when candidates are genuinely different entities that
  happen to share a word ("United States" ≠ "United Nations"; "Mercury"
  planet ≠ "Mercury" element; two people with the same name).
- Keep SEPARATE when a candidate is about an event involving the target
  rather than the target itself ("Smith appointed Director" ≠ "William
  Smith").
- Type is a hint, not absolute.
- Usually ONE candidate matches. Multiple matches imply the graph
  already has duplicates — list them all; the caller will reconcile.
- When uncertain (sparse descriptions, no strong signal), put the
  candidate in different_ids. False matches are worse than misses.`;

async function llmJudge(
  subject: ResolutionSubject,
  candidates: Candidate[],
  llmStep: LlmStep,
): Promise<EntityMatch[]> {
  const { client, model, maxTokens } = getLlmClient(llmStep);

  const input = {
    target: {
      label: subject.label,
      description: subject.description ?? "",
      keywords: subject.keywords ?? [],
      context: subject.context ?? "",
    },
    candidates: candidates.map((c) => ({
      id: c.id,
      label: c.label,
      type: c.type,
      description: c.short_description || c.description,
      keywords: c.keywords ?? [],
    })),
  };

  try {
    // Newer OpenAI reasoning models (o1, o3, gpt-5.*-nano) require
    // `max_completion_tokens`; `max_tokens` is deprecated and rejected.
    // The new param is backward-compatible with older models.
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content) as {
      same_as_ids?: string[];
      different_ids?: string[];
      rationale?: string;
    };
    const matches = (parsed.same_as_ids ?? []).filter((id) =>
      candidates.some((c) => c.id === id),
    );
    const rationale = parsed.rationale ?? "";

    if (matches.length === 0) return [];

    if (matches.length > 1) {
      console.log(
        `[entity-resolve] ambiguous match for "${subject.label}": ${matches.length} ` +
        `candidates (${matches.slice(0, 3).join(", ")}...) — caller will reconcile.`,
      );
    }

    // Preserve the LLM's ordering of same_as_ids (usually the judge puts the
    // best match first).
    return matches.map((id) => ({ id, confidence: 0.8, rationale }));
  } catch (err) {
    console.error("[entity-resolve] LLM judge failed:", (err as Error).message);
    return [];
  }
}
