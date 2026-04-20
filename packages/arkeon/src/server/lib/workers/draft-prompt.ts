// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiki drafting LLM prompt builder and response parser.
 *
 * Consumes a Dossier (from the gather agent) and produces a wiki page
 * by calling the "draft" LLM step. The output is a JSON object that
 * can be submitted directly to POST /wiki.
 */

import { getLlmClient } from "../llm.js";
import type { Dossier, PlaceholderInfo } from "./draft-gather.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftResponse {
  can_draft: boolean;
  refused_reason?: string;
  label: string;
  keywords: string[];
  short_description: string;
  content: string;
  aliases?: string[];
  subject_type?: string;
}

export interface DraftResult {
  draft: DraftResponse;
  usage: { tokensIn: number; tokensOut: number };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const MAX_DEPTH = 2;

function buildSystemPrompt(depth: number): string {
  const depthRemaining = MAX_DEPTH - depth;

  return `You are a wiki author for a collaborative knowledge graph. Given a subject entity and a research dossier, write a wiki article or determine that there is insufficient information.

Return ONLY a JSON object with this exact shape:
{
  "can_draft": true,
  "label": "Canonical Title",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "short_description": "One to two sentences summarizing the subject.",
  "content": "Markdown body of the wiki article...",
  "aliases": ["Alternative Name"],
  "subject_type": "person"
}

If the dossier contains absolutely no usable information beyond a bare label (no source document, no inbound references, no related context), return:
{
  "can_draft": false,
  "refused_reason": "Brief explanation of why drafting is not possible."
}
When source document text is provided, you should almost always be able to draft — extract and synthesize relevant information about the subject from it.

Rules for the markdown content:
- Write 200-800 words. Be concise and factual.
- Use ## headings for sections.
- Use ONLY information from the dossier. Do not hallucinate facts.
- Link to entities from the dossier using typed wiki links:
  - [[entity:ULID]] for entities listed in the dossier's confident links. IMPORTANT: entity links contain ONLY the bare ULID — no label, no pipe, no quotes. Correct: [[entity:01ABC123]]. WRONG: [[entity:01ABC123|Some Label]].
  - [[resolve:"Label"|"Description"]] for concepts that probably exist in the graph but you're not sure which entity
${depthRemaining > 0
    ? `  - [[assign:"Label"|"Description"]] for concepts that clearly need their own wiki page (spawns auto-drafting)`
    : `  - Do NOT use [[assign:...]] links — depth budget exhausted. Use [[resolve:...]] instead.`}
- Do not link to the subject itself.

Rules for metadata:
- label: the most common/canonical name for the subject
- keywords: 3-10 search terms (acronyms, alternate names, related concepts)
- short_description: 1-2 sentences shown in search previews
- aliases: alternate titles/spellings (optional, only if the subject has well-known alternatives)
- subject_type: semantic type like person, organization, concept, event, place, book, theory (optional)`;
}

function buildUserMessage(placeholder: PlaceholderInfo, dossier: Dossier): string {
  const parts: string[] = [];

  parts.push(`# Subject: "${placeholder.label}"`);
  if (placeholder.description) parts.push(`Description: ${placeholder.description}`);
  if (dossier.subjectSummary) parts.push(`Research summary: ${dossier.subjectSummary}`);
  parts.push("");

  if (dossier.inboundSpans.length > 0) {
    parts.push("## How This Subject Is Referenced");
    parts.push("These published wikis mention the subject in context:");
    for (const span of dossier.inboundSpans.slice(0, 15)) {
      parts.push(`- "${span.referrerLabel}" (${span.predicate}): "${span.spanText}"`);
    }
    parts.push("");
  }

  if (dossier.confidentEntityLinks.length > 0) {
    parts.push("## Entities You Can Link To (use [[entity:<id>]])");
    for (const ent of dossier.confidentEntityLinks.slice(0, 20)) {
      parts.push(`- ${ent.label} (${ent.type}, id=${ent.id}): ${ent.shortDescription}`);
    }
    parts.push("");
  }

  if (dossier.relatedWikiSnippets.length > 0) {
    parts.push("## Related Wikis (do not duplicate their content)");
    for (const wiki of dossier.relatedWikiSnippets.slice(0, 5)) {
      parts.push(`### ${wiki.label} (id=${wiki.id})`);
      parts.push(wiki.firstParagraph);
      parts.push("");
    }
  }

  if (dossier.sourceContent) {
    parts.push("## Source Document (primary material — cite and draw from this)");
    parts.push(`Source: "${dossier.sourceContent.label}"`);
    parts.push("");
    parts.push(dossier.sourceContent.content.slice(0, 20_000));
    parts.push("");
  }

  if (dossier.spaceWikiSample.length > 0) {
    parts.push("## Other Wikis in This Space (for voice/style reference)");
    for (const w of dossier.spaceWikiSample.slice(0, 10)) {
      parts.push(`- ${w.label}: ${w.shortDescription}`);
    }
    parts.push("");
  }

  if (dossier.gatherNotes) {
    parts.push(`## Research Notes`);
    parts.push(dossier.gatherNotes);
    parts.push("");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateDraft(
  placeholder: PlaceholderInfo,
  dossier: Dossier,
  depth: number,
): Promise<DraftResult> {
  const { client, model, maxTokens } = getLlmClient("draft");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(depth) },
      { role: "user", content: buildUserMessage(placeholder, dossier) },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: maxTokens,
  });

  const usage = {
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
  };

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return {
      draft: { can_draft: false, refused_reason: "LLM returned empty response", label: placeholder.label, keywords: [], short_description: "", content: "" },
      usage,
    };
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;

    const draft: DraftResponse = {
      can_draft: parsed.can_draft !== false && !!parsed.content,
      refused_reason: typeof parsed.refused_reason === "string" ? parsed.refused_reason : undefined,
      label: typeof parsed.label === "string" && parsed.label.trim() ? parsed.label.trim() : placeholder.label,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k): k is string => typeof k === "string") : [],
      short_description: typeof parsed.short_description === "string" ? parsed.short_description : "",
      content: typeof parsed.content === "string" ? parsed.content : "",
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((a): a is string => typeof a === "string") : undefined,
      subject_type: typeof parsed.subject_type === "string" ? parsed.subject_type : undefined,
    };

    // Ensure minimum metadata when can_draft is true
    if (draft.can_draft) {
      if (draft.keywords.length === 0) draft.keywords = [placeholder.label.toLowerCase()];
      if (draft.short_description.length < 10) {
        draft.short_description = dossier.subjectSummary.slice(0, 400) || `Wiki article about ${placeholder.label}.`;
      }
    }

    return { draft, usage };
  } catch (err) {
    console.error("[draft-prompt] Failed to parse LLM response:", content.slice(0, 200));
    return {
      draft: { can_draft: false, refused_reason: `JSON parse error: ${(err as Error).message}`, label: placeholder.label, keywords: [], short_description: "", content: "" },
      usage,
    };
  }
}
