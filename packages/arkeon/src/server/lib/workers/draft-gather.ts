// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Gather agent for the wiki draft worker.
 *
 * A read-only tool-calling loop that explores the graph to build a
 * context dossier for the drafting LLM. Pre-seeds deterministic context
 * (inbound spans, nearby entities, related wikis) then optionally runs
 * an LLM loop to follow leads and disambiguate.
 *
 * The LLM loop is gated: when the placeholder already has rich inbound
 * context (>=5 spans from >=2 distinct referrers), the static dossier
 * is good enough and the LLM loop is skipped entirely.
 *
 * All data access goes through the internal API client to prevent
 * schema drift — no direct SQL in this file.
 */

import type { Actor } from "../../types.js";
import type { EntityMatch } from "../entity-resolve.js";
import { getLlmClient } from "../llm.js";
import type OpenAI from "openai";
import * as api from "./internal-api.js";
import type { ApiEntity, ApiRelationship } from "./internal-api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboundSpan {
  referrerEntityId: string;
  referrerLabel: string;
  referrerShortDesc: string;
  predicate: string;
  spanText: string;
}

export interface DiscoveredEntity {
  id: string;
  label: string;
  type: string;
  shortDescription: string;
}

export interface WikiSnippet {
  id: string;
  label: string;
  firstParagraph: string;
}

export interface Dossier {
  subjectSummary: string;
  inboundSpans: InboundSpan[];
  confidentEntityLinks: DiscoveredEntity[];
  relatedWikiSnippets: WikiSnippet[];
  reconcileCandidates: EntityMatch[];
  spaceWikiSample: Array<{ label: string; shortDescription: string }>;
  /** Source document content if this placeholder was extracted from a raw source. */
  sourceContent: { label: string; content: string } | null;
  gatherNotes: string;
  usage: { tokensIn: number; tokensOut: number; turns: number };
}

export interface PlaceholderInfo {
  id: string;
  label: string;
  description: string | null;
  spaceId: string;
  subjectType: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TURNS = 8;
const WALL_TIME_MS = 30_000;
const RICH_SPAN_THRESHOLD = 5;
const RICH_REFERRER_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entityFromApi(e: ApiEntity): DiscoveredEntity {
  const props = e.properties;
  return {
    id: e.id,
    label: String(props.label ?? ""),
    type: e.type,
    shortDescription: String(props.short_description ?? "").slice(0, 200),
  };
}

/**
 * Get the counterpart entity from a relationship.
 * The API populates .source when direction=in, .target when direction=out.
 */
function counterpart(rel: ApiRelationship): { id: string; kind: string; type: string; properties: Record<string, unknown> } | undefined {
  return rel.direction === "in" ? rel.source : rel.target;
}

// ---------------------------------------------------------------------------
// Pre-seed: deterministic context gathering (no LLM)
// ---------------------------------------------------------------------------

async function fetchInboundSpans(placeholderId: string): Promise<InboundSpan[]> {
  const rels = await api.getRelationships(placeholderId, { direction: "in", limit: 30 });
  return rels.map((rel) => {
    const cp = counterpart(rel);
    const cpProps = cp?.properties ?? {};
    return {
      referrerEntityId: cp?.id ?? "",
      referrerLabel: String(cpProps.label ?? ""),
      referrerShortDesc: String(cpProps.short_description ?? "").slice(0, 200),
      predicate: String(rel.predicate),
      spanText: String((rel.properties.span_text as string) ?? "").slice(0, 400),
    };
  });
}

/**
 * If this placeholder was extracted from a source document, fetch the
 * source content so the drafting LLM has primary material to draw from.
 */
async function fetchSourceContent(
  placeholderId: string,
): Promise<{ sourceLabel: string; sourceContent: string } | null> {
  // Follow extracted_from edges outward from the placeholder
  const rels = await api.getRelationships(placeholderId, {
    direction: "out",
    predicate: "extracted_from",
    limit: 1,
  });
  if (rels.length === 0) return null;

  // The target of the extracted_from edge is the source file
  const targetId = rels[0]!.target_id;
  const file = await api.getFile(targetId);
  if (!file) return null;

  const content = String(file.properties.content ?? "");
  if (!content) return null;

  return {
    sourceLabel: String(file.properties.label ?? ""),
    sourceContent: content.slice(0, 30_000),
  };
}

async function searchNearbyEntities(
  label: string,
  description: string | null,
  spaceId: string,
): Promise<DiscoveredEntity[]> {
  const query = description ? `${label} ${description}`.slice(0, 200) : label;
  try {
    const result = await api.search({
      q: query,
      kind: "entity",
      space_id: spaceId,
      limit: 10,
    });
    return result.results.map(entityFromApi);
  } catch (err) {
    console.warn("[draft-gather] searchNearbyEntities failed:", (err as Error).message);
    return [];
  }
}

async function searchRelatedWikis(
  label: string,
  description: string | null,
  spaceId: string,
): Promise<WikiSnippet[]> {
  const query = description ? `${label} ${description}`.slice(0, 200) : label;
  try {
    const result = await api.search({
      q: query,
      type: "wiki",
      kind: "entity",
      space_id: spaceId,
      limit: 5,
    });
    return result.results.map((e) => {
      const content = String(e.properties.content ?? "");
      return {
        id: e.id,
        label: String(e.properties.label ?? ""),
        firstParagraph: content.split("\n\n")[0]?.slice(0, 500) ?? "",
      };
    });
  } catch (err) {
    console.warn("[draft-gather] searchRelatedWikis failed:", (err as Error).message);
    return [];
  }
}

async function fetchSpaceWikiSample(
  spaceId: string,
): Promise<Array<{ label: string; shortDescription: string }>> {
  try {
    const entities = await api.listEntities({
      space_id: spaceId,
      filter: "type:wiki",
      sort: "updated_at",
      order: "desc",
      limit: 10,
    });
    return entities.map((e) => ({
      label: String(e.properties.label ?? ""),
      shortDescription: String(e.properties.short_description ?? "").slice(0, 200),
    }));
  } catch (err) {
    console.warn("[draft-gather] fetchSpaceWikiSample failed:", (err as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool definitions for the gather LLM loop
// ---------------------------------------------------------------------------

const GATHER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_entities",
      description: "Search the knowledge graph for entities by text query",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text" },
          type_filter: { type: "string", description: "Filter by entity type (e.g. 'wiki', 'person')" },
          limit: { type: "number", description: "Max results (default 10, max 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_entity",
      description: "Fetch an entity's metadata by ID",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Entity ULID" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wiki_content",
      description: "Fetch the first portion of a wiki's markdown content",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Wiki entity ULID" },
          max_chars: { type: "number", description: "Max characters to return (default 2000, max 4000)" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "traverse",
      description: "List relationships for an entity (inbound, outbound, or both)",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Entity ULID" },
          direction: { type: "string", enum: ["in", "out", "both"], description: "Default: both" },
          limit: { type: "number", description: "Max edges (default 15, max 30)" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "emit_dossier",
      description: "Signal that you have gathered enough context. Call this when done.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "1-2 sentence summary of the subject based on what you found" },
          notes: { type: "string", description: "Notes for the drafting agent about what to focus on or watch out for" },
        },
        required: ["summary"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution via API
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  spaceId: string,
  discovered: DiscoveredEntity[],
  wikiSnippets: WikiSnippet[],
): Promise<unknown> {
  switch (name) {
    case "search_entities": {
      const query = String(args.query ?? "");
      const limit = Math.min(Number(args.limit) || 10, 20);
      // Sanitize type_filter — this value comes from LLM tool arguments
      let typeFilter: string | undefined;
      if (typeof args.type_filter === "string" && args.type_filter) {
        const safeType = args.type_filter.replace(/[^a-zA-Z0-9_-]/g, "");
        if (safeType) typeFilter = safeType;
      }

      try {
        const result = await api.search({
          q: query,
          kind: "entity",
          type: typeFilter,
          space_id: spaceId,
          limit,
        });
        const entities = result.results.map((e) => {
          const ent = entityFromApi(e);
          if (!discovered.some((d) => d.id === ent.id)) discovered.push(ent);
          return ent;
        });
        return { results: entities };
      } catch (err) {
        console.warn("[draft-gather] tool search_entities failed:", (err as Error).message);
        return { results: [], note: "Search unavailable" };
      }
    }

    case "get_entity": {
      const id = String(args.id ?? "");
      const entity = await api.getWikiEntity(id, "full");
      if (!entity) return { error: "Entity not found or not visible" };
      const props = entity.properties;
      const ent = entityFromApi(entity);
      if (!discovered.some((d) => d.id === ent.id)) discovered.push(ent);
      return {
        id: ent.id,
        type: ent.type,
        label: ent.label,
        description: String(props.description ?? "").slice(0, 400),
        keywords: Array.isArray(props.keywords) ? props.keywords : [],
        short_description: ent.shortDescription,
        aliases: Array.isArray(props.aliases) ? props.aliases : [],
      };
    }

    case "get_wiki_content": {
      const id = String(args.id ?? "");
      const maxChars = Math.min(Number(args.max_chars) || 2000, 4000);
      const entity = await api.getWikiEntity(id, "full");
      if (!entity || entity.type !== "wiki") return { error: "Wiki not found or not visible" };
      const props = entity.properties;
      const content = String(props.content ?? "").slice(0, maxChars);
      const label = String(props.label ?? "");
      const firstPara = content.split("\n\n")[0]?.slice(0, 500) ?? "";
      if (!wikiSnippets.some((w) => w.id === id)) {
        wikiSnippets.push({ id, label, firstParagraph: firstPara });
      }
      return { id, label, content };
    }

    case "traverse": {
      const id = String(args.id ?? "");
      const direction = String(args.direction ?? "both") as "in" | "out" | "both";
      const limit = Math.min(Number(args.limit) || 15, 30);
      const rels = await api.getRelationships(id, { direction, limit });
      return {
        edges: rels.map((rel) => {
          const other = counterpart(rel);
          const otherProps = other?.properties ?? {};
          return {
            predicate: rel.predicate,
            other_id: other?.id,
            other_label: String(otherProps.label ?? ""),
            other_type: other?.type,
            span_text: String((rel.properties.span_text as string) ?? "").slice(0, 300),
          };
        }),
      };
    }

    case "emit_dossier":
      return { status: "done" };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Gather agent system prompt
// ---------------------------------------------------------------------------

function buildGatherSystemPrompt(placeholder: PlaceholderInfo): string {
  return `You are a research agent gathering context to help draft a wiki article about "${placeholder.label}".

You have read-only access to a knowledge graph via these tools:
- search_entities: search by text query (searches label, keywords, short_description)
- get_entity: fetch an entity's metadata by ID
- get_wiki_content: read wiki page content (returns first N chars)
- traverse: list an entity's relationships (inbound/outbound edges with span_text)
- emit_dossier: signal you're done gathering (REQUIRED as your final tool call)

Your goal: find information, relationships, and context about "${placeholder.label}" to help a wiki author write a comprehensive article. Focus on:
1. What is this subject? Find entities and wikis that describe it.
2. How does it relate to other things in the graph? Follow relationships.
3. Are there existing wikis on closely related topics? Get their content for context.

You MUST call emit_dossier when you have enough context. Include a summary of the subject and notes for the drafting agent.

Keep your exploration focused. You have a limited number of tool calls.`;
}

function buildSeedMessage(
  placeholder: PlaceholderInfo,
  inboundSpans: InboundSpan[],
  nearbyEntities: DiscoveredEntity[],
  relatedWikis: WikiSnippet[],
  reconcileCandidates: EntityMatch[],
): string {
  const parts: string[] = [];

  parts.push(`Subject: "${placeholder.label}"`);
  if (placeholder.description) parts.push(`Description: ${placeholder.description}`);
  parts.push("");

  if (inboundSpans.length > 0) {
    parts.push("## Inbound References (published wikis that mention this subject)");
    for (const span of inboundSpans) {
      parts.push(`- From "${span.referrerLabel}": "${span.spanText}"`);
    }
    parts.push("");
  }

  if (nearbyEntities.length > 0) {
    parts.push("## Nearby Entities (search results for the subject label)");
    for (const ent of nearbyEntities) {
      parts.push(`- ${ent.label} (${ent.type}, id=${ent.id}): ${ent.shortDescription}`);
    }
    parts.push("");
  }

  if (relatedWikis.length > 0) {
    parts.push("## Related Published Wikis");
    for (const wiki of relatedWikis) {
      parts.push(`- ${wiki.label} (id=${wiki.id}): ${wiki.firstParagraph}`);
    }
    parts.push("");
  }

  if (reconcileCandidates.length > 0) {
    parts.push("## Ambiguous Matches (may or may not be the same subject)");
    for (const c of reconcileCandidates) {
      parts.push(`- id=${c.id} (confidence=${c.confidence}): ${c.rationale ?? ""}`);
    }
    parts.push("");
  }

  parts.push("Use tools to explore further, then call emit_dossier when ready.");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function gatherDossier(
  placeholder: PlaceholderInfo,
  actor: Actor,
  depth: number,
  reconcileCandidates: EntityMatch[],
): Promise<Dossier> {
  const usage = { tokensIn: 0, tokensOut: 0, turns: 0 };

  // Pre-seed deterministic context (all via API)
  const [inboundSpans, nearbyEntities, relatedWikis, spaceWikiSample, sourceDoc] = await Promise.all([
    fetchInboundSpans(placeholder.id),
    searchNearbyEntities(placeholder.label, placeholder.description, placeholder.spaceId),
    searchRelatedWikis(placeholder.label, placeholder.description, placeholder.spaceId),
    fetchSpaceWikiSample(placeholder.spaceId),
    fetchSourceContent(placeholder.id),
  ]);

  // Start with entities discovered during pre-seed
  const discovered: DiscoveredEntity[] = [...nearbyEntities];
  const wikiSnippets: WikiSnippet[] = [...relatedWikis];

  // Gating: if we have rich inbound context, skip the LLM loop
  const distinctReferrers = new Set(inboundSpans.map((s) => s.referrerEntityId)).size;
  if (inboundSpans.length >= RICH_SPAN_THRESHOLD && distinctReferrers >= RICH_REFERRER_THRESHOLD) {
    return {
      subjectSummary: `${placeholder.label}: referenced by ${inboundSpans.length} spans from ${distinctReferrers} wikis`,
      inboundSpans,
      confidentEntityLinks: discovered,
      relatedWikiSnippets: wikiSnippets,
      reconcileCandidates,
      spaceWikiSample,
      sourceContent: sourceDoc ? { label: sourceDoc.sourceLabel, content: sourceDoc.sourceContent } : null,
      gatherNotes: "Static dossier — rich inbound context, LLM gather skipped",
      usage,
    };
  }

  // LLM gather loop
  let subjectSummary = "";
  let gatherNotes = "";

  try {
    const { client, model, maxTokens } = getLlmClient("exists");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: buildGatherSystemPrompt(placeholder) },
      { role: "user", content: buildSeedMessage(placeholder, inboundSpans, nearbyEntities, relatedWikis, reconcileCandidates) },
    ];

    const startTime = Date.now();
    let done = false;

    while (!done && usage.turns < MAX_TURNS && (Date.now() - startTime) < WALL_TIME_MS) {
      const response = await client.chat.completions.create({
        model,
        messages,
        tools: GATHER_TOOLS,
        max_completion_tokens: maxTokens,
      });

      const choice = response.choices[0];
      if (!choice) break;

      usage.tokensIn += response.usage?.prompt_tokens ?? 0;
      usage.tokensOut += response.usage?.completion_tokens ?? 0;
      usage.turns++;

      const msg = choice.message;
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) break;

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        msg.tool_calls.map(async (tc) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }

          if (tc.function.name === "emit_dossier") {
            subjectSummary = String(args.summary ?? "");
            gatherNotes = String(args.notes ?? "");
            done = true;
            return { id: tc.id, content: JSON.stringify({ status: "done" }) };
          }

          try {
            const result = await executeTool(
              tc.function.name, args, placeholder.spaceId,
              discovered, wikiSnippets,
            );
            return { id: tc.id, content: JSON.stringify(result) };
          } catch (err) {
            return { id: tc.id, content: JSON.stringify({ error: (err as Error).message }) };
          }
        }),
      );

      for (const tr of toolResults) {
        messages.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      }
    }
  } catch (err) {
    console.warn("[draft-gather] LLM loop failed:", (err as Error).message);
    gatherNotes = `Gather agent failed: ${(err as Error).message}. Using static context only.`;
  }

  return {
    subjectSummary: subjectSummary || `${placeholder.label}: ${placeholder.description ?? "no description"}`,
    inboundSpans,
    confidentEntityLinks: discovered,
    relatedWikiSnippets: wikiSnippets,
    reconcileCandidates,
    spaceWikiSample,
    sourceContent: sourceDoc ? { label: sourceDoc.sourceLabel, content: sourceDoc.sourceContent } : null,
    gatherNotes,
    usage,
  };
}
