// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve [[resolve:"Label"|"Description"]] links via the shared
 * findSimilarEntities primitive (see entity-resolve.ts).
 *
 * This module is a thin adapter: it translates parsed wiki links into
 * ResolutionSubject / ResolutionOptions and wraps EntityMatch[] back
 * into ResolvedLink shape the wiki route expects.
 */

import type { ParsedLink } from "./wiki-links";
import { findSimilarEntities } from "./entity-resolve";
import type { Actor } from "../types";

export interface ResolvedLink {
  link: ParsedLink;
  /** The matched entity ID, or null if no match found. */
  entityId: string | null;
  /** 1.0 = exact normalized-label match; 0.8 = LLM-confirmed; 0 = no match. */
  confidence: number;
  /** Short rationale when LLM decided — surfaced in logs for auditability. */
  rationale?: string;
}

/**
 * Resolve a batch of [[resolve:...]] links. Returns one ResolvedLink
 * per input. Callers handle entityId=null as draft/gap per the current
 * depth budget.
 */
export async function resolveLinks(
  links: ParsedLink[],
  actor: Actor,
  spaceId?: string,
): Promise<ResolvedLink[]> {
  const results: ResolvedLink[] = [];
  for (const link of links) {
    const matches = await findSimilarEntities(
      {
        label: link.label ?? "",
        description: link.description,
        context: link.spanText,
      },
      {
        actor,
        spaceId,
        llmStep: "resolve",
      },
    );
    const first = matches[0];
    results.push({
      link,
      entityId: first?.id ?? null,
      confidence: first?.confidence ?? 0,
      rationale: first?.rationale,
    });
  }
  return results;
}
