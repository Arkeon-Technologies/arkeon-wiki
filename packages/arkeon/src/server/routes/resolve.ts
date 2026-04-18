// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /resolve — thin HTTP adapter over findSimilarEntities.
 *
 * Exposes the wiki pipeline's internal matching primitive as a callable
 * endpoint for:
 *   - agents pre-resolving subjects before submitting POST /wiki
 *   - the explorer UI to disambiguate search matches
 *   - manual end-to-end testing of the resolve pipeline
 *
 * Given a subject (label + optional description/keywords/context), runs
 * multi-query Meilisearch + LLM judge and returns the confirmed matches
 * in rank order.
 */

import { createRoute, z } from "@hono/zod-openapi";

import { requireActor, parseJsonBody } from "../lib/http";
import { ApiError } from "../lib/errors";
import { createRouter } from "../lib/openapi";
import { findSimilarEntities, type ResolutionOptions } from "../lib/entity-resolve";
import { isLlmConfigured } from "../lib/llm";
import { EntityIdParam, errorResponses, jsonContent } from "../lib/schemas";

const resolveSubjectRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "resolveSubject",
  tags: ["Resolve"],
  summary: "Find existing entities matching a subject via multi-query Meilisearch + LLM judge",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /wiki", "GET /search"],
  "x-arke-rules": [
    "Returns 503 if no LLM provider is configured (see ~/.arkeon/llm.json)",
  ],
  request: {
    body: {
      content: jsonContent(
        z.object({
          label: z.string().min(1).max(400).describe("Canonical name of the thing to match"),
          description: z.string().max(2000).optional().describe("Free-form description — used both for query generation and as disambiguation context"),
          keywords: z.array(z.string().min(1).max(200)).max(20).optional().describe("Alternate names/search phrasings (each becomes its own Meilisearch query)"),
          context: z.string().max(4000).optional().describe("Surrounding prose passed to the LLM judge as disambiguation hints — never used as a search query"),
          space_id: EntityIdParam.optional().describe("If set, restrict candidates to this space"),
          candidate_filter: z.array(z.string().min(1).max(200)).max(10).optional().describe("Additional Meilisearch filters, e.g. [\"type = \\\"wiki\\\"\"]"),
          llm_step: z.enum(["resolve", "exists", "dedup"]).optional().describe("Which LLM step config to use (defaults to \"resolve\")"),
          limit: z.number().int().min(1).max(20).optional().describe("Max matches to return (default: all)"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Matches (possibly empty) in rank order",
      content: jsonContent(
        z.object({
          matches: z.array(
            z.object({
              id: EntityIdParam,
              confidence: z.number().describe("1.0 = exact normalized-label match; 0.8 = LLM-confirmed; 0 = no match"),
              rationale: z.string().optional().describe("Short explanation of the match decision"),
            }),
          ),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 503]),
  },
});

export const resolveRouter = createRouter();

resolveRouter.openapi(resolveSubjectRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    throw new ApiError(400, "invalid_request", "label is required and must be a non-empty string");
  }

  if (!isLlmConfigured()) {
    throw new ApiError(
      503,
      "llm_not_configured",
      "No LLM provider is configured. Run `arkeon init --llm-*` or set OPENAI_API_KEY.",
    );
  }

  const description = typeof body.description === "string" ? body.description : undefined;
  const context = typeof body.context === "string" ? body.context : undefined;
  const keywordsRaw = body.keywords;
  const keywords = Array.isArray(keywordsRaw)
    ? keywordsRaw.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : undefined;

  const spaceId = typeof body.space_id === "string" ? body.space_id : undefined;
  const candidateFilter = Array.isArray(body.candidate_filter)
    ? body.candidate_filter.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : undefined;
  const llmStep = body.llm_step as ResolutionOptions["llmStep"] | undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;

  const matches = await findSimilarEntities(
    { label, description, keywords, context },
    {
      actor,
      spaceId,
      candidateFilter,
      llmStep,
    },
  );

  const trimmed = typeof limit === "number" ? matches.slice(0, limit) : matches;

  return c.json(
    {
      matches: trimmed,
    },
    200,
  );
});
