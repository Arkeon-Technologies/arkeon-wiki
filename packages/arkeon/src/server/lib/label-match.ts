// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Label normalization + query generation for wiki resolve and wiki
 * exists steps. Ported from the knowledge pipeline's dedupe module —
 * same pattern, different caller.
 *
 * The goal is to deterministically turn a free-form label (and
 * optionally a description) into a small set of Meilisearch queries
 * that together are likely to surface any existing entity/wiki on
 * the same subject. Running each query independently, then unioning
 * the results, catches cases a single combined query misses — e.g.
 * "Matt Connelly" won't rank an entity labeled just "Connelly" at the
 * top, but a single-word query for "connelly" will.
 */

/**
 * Loose normalization for query generation: lowercase, strip common
 * leading articles ("The", "A") and honorifics ("Dr.", "Gen."),
 * collapse whitespace. Used by buildCandidateQueries to produce a
 * token-stripped query variant — being aggressive helps Meilisearch
 * recall. NOT used to decide whether two labels are "the same" —
 * see strictNormalizeLabel below for that.
 */
export function normalizeLabel(label: string): string {
  // Trim and collapse whitespace first so the anchored article/honorific
  // regexes don't fail on inputs with leading spaces.
  return label
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(
      /^(col\.|gen\.|adm\.|dr\.|mr\.|mrs\.|ms\.|prof\.|minister|ambassador|secretary)\s+/i,
      "",
    )
    .trim();
}

/**
 * Strict normalization for the exact-match short-circuit: lowercase +
 * whitespace collapse + trim. Nothing else. Two labels equal under
 * this function are the same string modulo trivial formatting.
 *
 * "William Smith" == "william smith"       — yes (case)
 * "William  Smith" == "William Smith"      — yes (whitespace)
 * "Dr. Smith" == "Smith"                   — NO  (honorific is meaningful)
 * "The Nile" == "Nile"                     — NO  (article is meaningful)
 * "Mercury" == "Mercury"                   — yes
 *
 * This is the only comparison used to decide "skip the LLM, auto-match
 * with confidence 1.0." Anything that needs to deal with articles,
 * honorifics, abbreviations, aliases, synonyms, or any other kind of
 * label variation MUST go through the LLM judge — there is no safe
 * heuristic short-circuit for those.
 */
export function strictNormalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

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

const MAX_QUERIES = 10;

/**
 * Build a set of search queries from a label and an optional
 * description. Includes the raw label, the normalized label, each
 * non-stop-word content token from both, and — if the description is
 * long enough — the description itself as a phrase.
 *
 * Single-token queries find candidates where only one word of the
 * label appears in the indexed label attribute. Multi-word queries
 * catch exact phrase matches. The union of results is deduped by
 * caller using entity ID.
 */
export function buildCandidateQueries(
  label: string,
  description?: string,
  keywords?: string[],
): string[] {
  const queries = new Set<string>();
  const labelRaw = label.trim();
  if (labelRaw) {
    queries.add(labelRaw);
    queries.add(normalizeLabel(labelRaw));
  }

  const labelTokens = normalizeLabel(labelRaw).split(" ").filter(Boolean);
  for (const token of labelTokens) {
    if (!STOP_WORDS.has(token) && token.length > 1) {
      queries.add(token);
    }
  }

  // Author-provided keywords are already high-quality queries by
  // construction — each one was chosen as an alternative name or common
  // search phrasing. Add them as standalone queries before any derived
  // description tokens so they get priority when we hit the cap.
  if (keywords) {
    for (const kw of keywords) {
      const trimmed = kw.trim();
      if (trimmed) queries.add(trimmed);
    }
  }

  if (description) {
    const descTrim = description.trim();
    // Only include the full description as a query if it's short enough to
    // be a meaningful phrase match. Longer descriptions dissolve into bag-
    // of-words matching and add noise.
    if (descTrim && descTrim.length <= 120) {
      queries.add(descTrim);
    }
    const descTokens = normalizeLabel(descTrim).split(" ").filter(Boolean);
    for (const token of descTokens) {
      if (!STOP_WORDS.has(token) && token.length > 2) {
        queries.add(token);
      }
    }
  }

  return [...queries].filter(Boolean).slice(0, MAX_QUERIES);
}
