// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiki enrichment LLM prompt builder and response parser.
 *
 * Takes an existing wiki article and a new source document, and produces
 * an updated article that incorporates the new source's perspective while
 * preserving the existing content's structure and voice.
 */

import { getLlmClient } from "../llm.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichResponse {
  enriched: boolean;
  reason?: string;
  content: string;
  keywords: string[];
  short_description: string;
}

export interface EnrichResult {
  response: EnrichResponse;
  usage: { tokensIn: number; tokensOut: number };
}

export interface EnrichContext {
  /** The wiki entity being enriched. */
  wiki: {
    label: string;
    content: string;
    keywords: string[];
    short_description: string;
    ver: number;
  };
  /** The new source document to enrich from. */
  source: {
    label: string;
    content: string;
  };
  /** Labels of sources already incorporated into this wiki. */
  incorporatedSources: string[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are enriching an existing wiki article with new information from an additional source document.

The existing article was written based on earlier sources. A new source document has been ingested that also discusses this subject. Your job is to UPDATE the article to incorporate the new source's perspective while preserving the existing content's structure and voice.

Return ONLY a JSON object:
{
  "enriched": true,
  "content": "Updated markdown body...",
  "keywords": ["updated", "keyword", "list"],
  "short_description": "Updated summary if the new source adds significant context"
}

Only return enriched: false if the new source is completely unrelated to the subject — i.e., the subject is not mentioned or discussed at all. If the source mentions the subject even briefly, or discusses closely related topics that add context, you should enrich. Be generous: a new perspective, a parallel, additional context, or even a passing reference that adds color is worth incorporating.

{
  "enriched": false,
  "reason": "Brief explanation"
}

Rules for enrichment:
- Preserve existing sections and their structure
- ADD new sections or paragraphs where the new source provides uncovered information
- EXPAND existing sections where the new source offers additional perspective or context
- Draw connections: if the new source discusses related themes, characters, or events, add a section noting those connections even if the subject is only briefly mentioned
- Do not remove or contradict existing content unless correcting a factual error
- Maintain the same writing style and heading structure
- Weave new content in naturally — do not append a "New from Source B" section or label content by source
- Use the same wiki link syntax as the existing article: [[entity:ULID]], [[resolve:"Label"|"Description"]], [[assign:"Label"|"Description"]]
- Keep the article between 200-1500 words (enrichment can grow it beyond the initial 800 cap)
- Update keywords to include any new search terms from the new source
- Update short_description only if the new source significantly expands the subject's scope`;

function buildUserMessage(ctx: EnrichContext): string {
  const parts: string[] = [];

  parts.push(`# Subject: "${ctx.wiki.label}"`);
  parts.push(`Current article version: ${ctx.wiki.ver}`);
  parts.push("");

  parts.push("## Existing Article Content");
  parts.push(ctx.wiki.content);
  parts.push("");

  parts.push(`## New Source Document: "${ctx.source.label}"`);
  parts.push(ctx.source.content.slice(0, 50_000));
  parts.push("");

  if (ctx.incorporatedSources.length > 0) {
    parts.push("## Previously Incorporated Sources");
    for (const src of ctx.incorporatedSources) {
      parts.push(`- ${src} (already reflected in the article)`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateEnrichment(ctx: EnrichContext): Promise<EnrichResult> {
  const { client, model, maxTokens } = getLlmClient("enrich");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(ctx) },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: maxTokens,
  });

  const usage = {
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
  };

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    return {
      response: { enriched: false, reason: "LLM returned empty response", content: "", keywords: [], short_description: "" },
      usage,
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const result: EnrichResponse = {
      enriched: parsed.enriched !== false && !!parsed.content,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      content: typeof parsed.content === "string" ? parsed.content : "",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k): k is string => typeof k === "string") : ctx.wiki.keywords,
      short_description: typeof parsed.short_description === "string" && parsed.short_description.length >= 10
        ? parsed.short_description
        : ctx.wiki.short_description,
    };

    return { response: result, usage };
  } catch (err) {
    console.error("[enrich-prompt] Failed to parse LLM response:", raw.slice(0, 200));
    return {
      response: { enriched: false, reason: `JSON parse error: ${(err as Error).message}`, content: "", keywords: [], short_description: "" },
      usage,
    };
  }
}
