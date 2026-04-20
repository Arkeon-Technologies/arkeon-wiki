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
 */

import type { Actor } from "../../types.js";
import type { EntityMatch } from "../entity-resolve.js";
import { searchEntities, isMeilisearchConfigured } from "../meilisearch.js";
import { withTransaction, type SqlClient } from "../sql.js";
import { setActorContext } from "../actor-context.js";
import { getLlmClient } from "../llm.js";
import type OpenAI from "openai";

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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TURNS = 8;
const WALL_TIME_MS = 30_000;
const RICH_SPAN_THRESHOLD = 5;
const RICH_REFERRER_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Pre-seed: deterministic context gathering (no LLM)
// ---------------------------------------------------------------------------

async function fetchInboundSpans(
  placeholderId: string,
  actor: Actor,
): Promise<InboundSpan[]> {
  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;

    const rows = await sql`
      SELECT
        re.predicate,
        rel.properties AS rel_props,
        src.id AS referrer_id,
        src.properties AS src_props
      FROM relationship_edges re
      JOIN entities rel ON rel.id = re.id
      JOIN entities src ON src.id = re.source_id
      WHERE re.target_id = ${placeholderId}
      ORDER BY rel.created_at DESC
      LIMIT 30
    `;

    return (rows as Array<Record<string, unknown>>).map((r) => {
      const relProps = (r.rel_props as Record<string, unknown>) ?? {};
      const srcProps = (r.src_props as Record<string, unknown>) ?? {};
      return {
        referrerEntityId: String(r.referrer_id),
        referrerLabel: String(srcProps.label ?? ""),
        referrerShortDesc: String(srcProps.short_description ?? "").slice(0, 200),
        predicate: String(r.predicate),
        spanText: String(relProps.span_text ?? "").slice(0, 400),
      };
    });
  });
}

/**
 * If this placeholder was extracted from a source document, fetch the
 * source content so the drafting LLM has primary material to draw from.
 */
async function fetchSourceContent(
  placeholderId: string,
  actor: Actor,
): Promise<{ sourceLabel: string; sourceContent: string } | null> {
  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;

    // Follow extracted_from edges from this placeholder to a source entity
    const rows = await sql`
      SELECT src.properties AS src_props
      FROM relationship_edges re
      JOIN entities src ON src.id = re.target_id
      WHERE re.source_id = ${placeholderId}
        AND re.predicate = 'extracted_from'
        AND src.type = 'source'
      LIMIT 1
    `;
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    const srcProps = (row.src_props as Record<string, unknown>) ?? {};
    const content = String(srcProps.content ?? "");
    if (!content) return null;
    return {
      sourceLabel: String(srcProps.label ?? ""),
      sourceContent: content.slice(0, 30_000), // cap for context window
    };
  });
}

async function searchNearbyEntities(
  label: string,
  description: string | null,
  actor: Actor,
  spaceId: string,
): Promise<DiscoveredEntity[]> {
  if (!isMeilisearchConfigured()) return [];

  const query = description ? `${label} ${description}`.slice(0, 200) : label;
  const result = await searchEntities(query, {
    filter: [
      'kind = "entity"',
      `space_ids = "${spaceId}"`,
    ],
    limit: 10,
    attributesToSearchOn: ["label", "keywords", "short_description"],
  });

  if (result.ids.length === 0) return [];

  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;
    const rows = await sql`
      SELECT id, type, properties FROM entities
      WHERE id = ANY(${result.ids}) AND kind = 'entity'
    `;
    const byId = new Map<string, DiscoveredEntity>();
    for (const r of rows as Array<Record<string, unknown>>) {
      const props = (r.properties as Record<string, unknown>) ?? {};
      byId.set(String(r.id), {
        id: String(r.id),
        label: String(props.label ?? ""),
        type: String(r.type),
        shortDescription: String(props.short_description ?? "").slice(0, 200),
      });
    }
    return result.ids.map((id) => byId.get(id)).filter((e): e is DiscoveredEntity => !!e);
  });
}

async function searchRelatedWikis(
  label: string,
  description: string | null,
  actor: Actor,
  spaceId: string,
): Promise<WikiSnippet[]> {
  if (!isMeilisearchConfigured()) return [];

  const query = description ? `${label} ${description}`.slice(0, 200) : label;
  const result = await searchEntities(query, {
    filter: [
      'kind = "entity"',
      'type = "wiki"',
      `space_ids = "${spaceId}"`,
    ],
    limit: 5,
    attributesToSearchOn: ["label", "keywords", "short_description"],
  });

  if (result.ids.length === 0) return [];

  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;
    const rows = await sql`
      SELECT id, properties FROM entities
      WHERE id = ANY(${result.ids}) AND type = 'wiki'
    `;
    return (rows as Array<Record<string, unknown>>).map((r) => {
      const props = (r.properties as Record<string, unknown>) ?? {};
      const content = String(props.content ?? "");
      const firstPara = content.split("\n\n")[0]?.slice(0, 500) ?? "";
      return {
        id: String(r.id),
        label: String(props.label ?? ""),
        firstParagraph: firstPara,
      };
    });
  });
}

async function fetchSpaceWikiSample(
  spaceId: string,
  actor: Actor,
): Promise<Array<{ label: string; shortDescription: string }>> {
  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;
    const rows = await sql`
      SELECT e.properties FROM entities e
      JOIN space_entities se ON se.entity_id = e.id
      WHERE se.space_id = ${spaceId}
        AND e.type = 'wiki'
        AND e.kind = 'entity'
      ORDER BY e.updated_at DESC
      LIMIT 10
    `;
    return (rows as Array<Record<string, unknown>>).map((r) => {
      const props = (r.properties as Record<string, unknown>) ?? {};
      return {
        label: String(props.label ?? ""),
        shortDescription: String(props.short_description ?? "").slice(0, 200),
      };
    });
  });
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
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  actor: Actor,
  spaceId: string,
  discovered: DiscoveredEntity[],
  wikiSnippets: WikiSnippet[],
): Promise<unknown> {
  switch (name) {
    case "search_entities": {
      const query = String(args.query ?? "");
      const limit = Math.min(Number(args.limit) || 10, 20);
      const filters: string[] = [
        'kind = "entity"',
        `space_ids = "${spaceId}"`,
      ];
      if (typeof args.type_filter === "string" && args.type_filter) {
        filters.push(`type = "${args.type_filter}"`);
      }
      if (!isMeilisearchConfigured()) return { results: [], note: "Search not configured" };
      const result = await searchEntities(query, {
        filter: filters,
        limit,
        attributesToSearchOn: ["label", "keywords", "short_description"],
      });
      if (result.ids.length === 0) return { results: [] };

      return withTransaction(async (sql) => {
        for (const q of setActorContext(sql, actor)) await q;
        const rows = await sql`
          SELECT id, type, properties FROM entities
          WHERE id = ANY(${result.ids}) AND kind = 'entity'
        `;
        const entities = (rows as Array<Record<string, unknown>>).map((r) => {
          const props = (r.properties as Record<string, unknown>) ?? {};
          const ent: DiscoveredEntity = {
            id: String(r.id),
            label: String(props.label ?? ""),
            type: String(r.type),
            shortDescription: String(props.short_description ?? "").slice(0, 200),
          };
          // Track discovered entities for the dossier
          if (!discovered.some((d) => d.id === ent.id)) discovered.push(ent);
          return ent;
        });
        return { results: entities };
      });
    }

    case "get_entity": {
      const id = String(args.id ?? "");
      return withTransaction(async (sql) => {
        for (const q of setActorContext(sql, actor)) await q;
        const rows = await sql`
          SELECT id, type, properties FROM entities WHERE id = ${id} AND kind = 'entity' LIMIT 1
        `;
        if (rows.length === 0) return { error: "Entity not found or not visible" };
        const r = rows[0] as Record<string, unknown>;
        const props = (r.properties as Record<string, unknown>) ?? {};
        const ent: DiscoveredEntity = {
          id: String(r.id),
          label: String(props.label ?? ""),
          type: String(r.type),
          shortDescription: String(props.short_description ?? "").slice(0, 200),
        };
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
      });
    }

    case "get_wiki_content": {
      const id = String(args.id ?? "");
      const maxChars = Math.min(Number(args.max_chars) || 2000, 4000);
      return withTransaction(async (sql) => {
        for (const q of setActorContext(sql, actor)) await q;
        const rows = await sql`
          SELECT id, properties FROM entities WHERE id = ${id} AND type = 'wiki' LIMIT 1
        `;
        if (rows.length === 0) return { error: "Wiki not found or not visible" };
        const r = rows[0] as Record<string, unknown>;
        const props = (r.properties as Record<string, unknown>) ?? {};
        const content = String(props.content ?? "").slice(0, maxChars);
        const label = String(props.label ?? "");
        const firstPara = content.split("\n\n")[0]?.slice(0, 500) ?? "";
        if (!wikiSnippets.some((w) => w.id === id)) {
          wikiSnippets.push({ id, label, firstParagraph: firstPara });
        }
        return { id, label, content };
      });
    }

    case "traverse": {
      const id = String(args.id ?? "");
      const direction = String(args.direction ?? "both");
      const limit = Math.min(Number(args.limit) || 15, 30);
      return withTransaction(async (sql) => {
        for (const q of setActorContext(sql, actor)) await q;

        let dirClause: string;
        if (direction === "out") dirClause = `re.source_id = $1`;
        else if (direction === "in") dirClause = `re.target_id = $1`;
        else dirClause = `(re.source_id = $1 OR re.target_id = $1)`;

        const rows = await sql.query(
          `SELECT
            re.predicate,
            re.source_id,
            re.target_id,
            rel.properties AS rel_props,
            other.id AS other_id,
            other.type AS other_type,
            other.properties AS other_props
          FROM relationship_edges re
          JOIN entities rel ON rel.id = re.id
          JOIN entities other ON other.id = CASE
            WHEN re.source_id = $1 THEN re.target_id
            ELSE re.source_id
          END
          WHERE ${dirClause}
          ORDER BY rel.created_at DESC
          LIMIT $2`,
          [id, limit],
        );

        return {
          edges: (rows as Array<Record<string, unknown>>).map((r) => {
            const relProps = (r.rel_props as Record<string, unknown>) ?? {};
            const otherProps = (r.other_props as Record<string, unknown>) ?? {};
            return {
              predicate: r.predicate,
              other_id: r.other_id,
              other_label: String(otherProps.label ?? ""),
              other_type: r.other_type,
              span_text: String(relProps.span_text ?? "").slice(0, 300),
            };
          }),
        };
      });
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

  // Pre-seed deterministic context
  const [inboundSpans, nearbyEntities, relatedWikis, spaceWikiSample, sourceDoc] = await Promise.all([
    fetchInboundSpans(placeholder.id, actor),
    searchNearbyEntities(placeholder.label, placeholder.description, actor, placeholder.spaceId),
    searchRelatedWikis(placeholder.label, placeholder.description, actor, placeholder.spaceId),
    fetchSpaceWikiSample(placeholder.spaceId, actor),
    fetchSourceContent(placeholder.id, actor),
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
              tc.function.name, args, actor, placeholder.spaceId,
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
