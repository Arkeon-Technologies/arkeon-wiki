// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared tool registry.
 *
 * Each entry wires a library function into the agent runtime. Roles
 * list tool names; the runtime instantiates each named factory with
 * the AgentContext.
 *
 * Adding a new tool: one entry here. The cost is the description and
 * the Zod input schema, not the registration line.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import { z } from "zod";

import { safeResolve } from "../lib/file-edits.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { searchKeyword, searchVector } from "../lib/search.js";
import { listEntities, parseEntityTypes, type EntityType } from "../lib/entities.js";

import { defineTool, type ToolFactory } from "./define-tool.js";

// ── read_file ─────────────────────────────────────────────────────

const readFileTool = defineTool("read_file", {
  description:
    "Read a file from the current space. Path is relative to the space's watch_dir. " +
    "For markdown files, parsed YAML frontmatter is returned alongside the body.",
  inputSchema: z.object({
    path: z.string().describe("Relative path inside the space's watch_dir."),
  }),
  call: ({ path }, ctx) => {
    const absPath = safeResolve(ctx.space.watch_dir, path);
    if (!existsSync(absPath)) {
      throw new Error(`read_file: ${path} does not exist`);
    }
    if (statSync(absPath).isDirectory()) {
      throw new Error(`read_file: ${path} is a directory`);
    }
    const content = readFileSync(absPath, "utf-8");
    if (path.endsWith(".md")) {
      const parsed = parseFrontmatter(content);
      return {
        path,
        frontmatter: parsed.properties,
        body: parsed.body,
      };
    }
    return { path, content };
  },
  summarize: (r) => {
    const text = "body" in r ? r.body : r.content;
    return {
      path: r.path,
      body_chars: text?.length ?? 0,
      has_frontmatter: "frontmatter" in r,
    };
  },
});

// ── search ────────────────────────────────────────────────────────

const searchTool = defineTool("search", {
  description:
    "Search the current space. Two strategies, no fusion:\n" +
    "  - keyword (ripgrep): exact substring (or regex) over file contents. " +
    "Best for proper nouns, code identifiers, ULIDs, exact phrases.\n" +
    "  - vector (sqlite-vec): semantic similarity. Returns a ranked list " +
    "of WIKIS — each hit is a complete wiki with its full body and " +
    "frontmatter, deduplicated from chunk-level matches under the hood. " +
    "Best for finding related or possibly-duplicate wikis you don't have " +
    "a literal name for. The body is right there in the response, so " +
    "there's no need to read_file the wiki separately to inspect it.\n" +
    "Default `mode=both` runs both in parallel and returns each result " +
    "set in its own namespace ({keyword, vector}). Pass `mode=keyword` " +
    "or `mode=vector` to scope to one. Vector results carry similarity " +
    "scores in [-1, 1] (higher = more similar); keyword hits are " +
    "ranked by match count with line snippets.",
  inputSchema: z.object({
    query: z.string().describe("The query string."),
    mode: z
      .enum(["keyword", "vector", "both"])
      .optional()
      .describe(
        "Which strategy to run. Default 'both'. Use 'vector' alone when " +
          "you want semantic matches and don't care about literal substrings.",
      ),
    regex: z
      .boolean()
      .optional()
      .describe(
        "Treat query as a regex (keyword mode only — ignored for vector).",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max hits per strategy. Default 20 for keyword, 8 for vector " +
          "(vector hits include full wiki bodies, so K is smaller).",
      ),
    max_snippets_per_file: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max line snippets per keyword hit (default 3)."),
  }),
  call: async ({ query, mode, regex, limit, max_snippets_per_file }, ctx) => {
    const m = mode ?? "both";
    const wantKeyword = m === "keyword" || m === "both";
    const wantVector = m === "vector" || m === "both";

    // Run requested strategies in parallel, fail-soft per strategy:
    // if vector throws (e.g. embedder still warming up), the agent
    // still sees keyword results.
    const [keywordSettled, vectorSettled] = await Promise.allSettled([
      wantKeyword
        ? searchKeyword({
            query,
            spaceId: ctx.space.id,
            regex,
            limit,
            maxSnippetsPerFile: max_snippets_per_file,
          })
        : Promise.resolve(null),
      wantVector
        ? searchVector({ query, spaceId: ctx.space.id, limit })
        : Promise.resolve(null),
    ]);

    const out: Record<string, unknown> = { query, mode: m };
    if (wantKeyword) {
      out.keyword =
        keywordSettled.status === "fulfilled" && keywordSettled.value
          ? keywordSettled.value
          : { hits: [], total: 0, unmatched_files: 0 };
    }
    if (wantVector) {
      out.vector =
        vectorSettled.status === "fulfilled" && vectorSettled.value
          ? vectorSettled.value
          : { hits: [], total: 0, model: "unavailable" };
    }
    return out;
  },
  summarize: (r) => {
    const k = r.keyword as { hits?: unknown[]; total?: number } | undefined;
    const v = r.vector as { hits?: unknown[]; total?: number; model?: string } | undefined;
    return {
      query: r.query,
      mode: r.mode,
      keyword_hits: k?.hits?.length,
      keyword_total: k?.total,
      vector_hits: v?.hits?.length,
      vector_total: v?.total,
      vector_model: v?.model,
    };
  },
});

// ── list_entities ─────────────────────────────────────────────────

const listEntitiesTool = defineTool("list_entities", {
  description:
    "List entities in the current space — wikis, source files, and stubs " +
    "(placeholders left by [[wikilink]] references) — with structural " +
    "filters. Use this to check whether a subject already has a wiki, " +
    "find sources you haven't cited yet (type=file inbound_max=0), find " +
    "stubs that need filling (type=stub), or surface wikis with open " +
    "threads (has_unresolved_outbound=true). Returns " +
    "{entities, total, limit, offset}.",
  inputSchema: z.object({
    type: z
      .string()
      .optional()
      .describe(
        "Comma-separated entity types: any of 'wiki', 'file', 'stub'. " +
          "Omit to include all types. Examples: 'wiki' (just wikis), " +
          "'wiki,stub' (wikis and the stubs they point to), 'stub' (only " +
          "things to fill).",
      ),
    subject_type: z
      .string()
      .optional()
      .describe("Filter on frontmatter `subject_type` (e.g. 'person', 'concept')."),
    status: z
      .string()
      .optional()
      .describe(
        "Filter on frontmatter `status` — free-form, whatever values you " +
          "put in your wikis (e.g. 'draft', 'review', 'published').",
      ),
    label_contains: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring match on the entity's label. " +
          "'Baker Street' matches '221B Baker Street'. Useful for checking " +
          "whether a subject already exists under some variant of its name.",
      ),
    inbound_min: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Inclusive lower bound on inbound relationship count."),
    inbound_max: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive upper bound on inbound relationship count. Combine " +
          "with type='file' inbound_max=0 to find sources nothing has " +
          "cited yet.",
      ),
    outbound_min: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Inclusive lower bound on outbound relationship count."),
    outbound_max: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Inclusive upper bound on outbound relationship count."),
    has_unresolved_outbound: z
      .boolean()
      .optional()
      .describe(
        "True: only entities with at least one outbound link to a stub " +
          "(i.e. wikis with open threads). False: only entities whose " +
          "outbound links all resolve to real entities.",
      ),
    updated_since: z
      .string()
      .optional()
      .describe(
        "ISO timestamp; only entities with updated_at >= this. Useful " +
          "for 'what changed in the last hour' style queries.",
      ),
    edited_by_role: z
      .string()
      .optional()
      .describe(
        "Filter on the entity's most recent edit's by_role — e.g. " +
          "'human' for filesystem-driven changes, 'ingestor'/'consolidator' " +
          "for agent edits.",
      ),
    sort: z
      .enum(["updated_at", "label", "inbound", "outbound"])
      .optional()
      .describe(
        "Default 'updated_at' (newest first). 'inbound' / 'outbound' " +
          "rank by relationship count (descending).",
      ),
    include_counts: z
      .boolean()
      .optional()
      .describe(
        "Attach inbound/outbound relationship counts per entity.",
      ),
    limit: z.number().int().positive().optional().describe("Default 100, max 10000."),
    offset: z.number().int().min(0).optional().describe("Pagination offset, default 0."),
  }),
  call: (input, ctx) => {
    let types: EntityType[] | undefined;
    try {
      types = parseEntityTypes(input.type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`list_entities: ${msg}`);
    }
    return listEntities({
      space_id: ctx.space.id,
      types,
      subject_type: input.subject_type,
      status: input.status,
      label_contains: input.label_contains,
      inbound_min: input.inbound_min,
      inbound_max: input.inbound_max,
      outbound_min: input.outbound_min,
      outbound_max: input.outbound_max,
      has_unresolved_outbound: input.has_unresolved_outbound,
      updated_since: input.updated_since,
      edited_by_role: input.edited_by_role,
      sort: input.sort,
      include_counts: input.include_counts,
      limit: input.limit,
      offset: input.offset,
    });
  },
  summarize: (r) => {
    const entities = (r as { entities?: unknown[] }).entities;
    const total = (r as { total?: number }).total;
    return {
      total,
      returned: Array.isArray(entities) ? entities.length : undefined,
    };
  },
});

// ── edit_file ─────────────────────────────────────────────────────

/**
 * One mutation tool, five modes — explicit `mode` discriminator. Each
 * mode carries its own params:
 *
 *   - create          { path, content }                 — new file
 *   - append          { path, content }                 — add to end of existing file
 *   - replace         { path, search, replace }         — Aider-style surgical edit
 *   - annotate        { path, insert_after_phrase, insert_text }
 *                       — splice text after a unique anchor phrase,
 *                         leaving everything else verbatim. Phrase-only
 *                         contract is load-bearing: the model points,
 *                         the runtime inserts. There is no field in
 *                         which the model could express "and tidy the
 *                         neighbouring sentence too." Prefer this over
 *                         REPLACE for additive edits.
 *   - delete_section  { path, heading }
 *                       — remove an ATX heading and its body, up to
 *                         (but not including) the next same-or-higher
 *                         heading.
 *
 * Whole-file deletion lives in `delete_wiki` (different tool: guarded
 * `wiki/` prefix, required `reason`).
 */
const editFileTool = defineTool("edit_file", {
  description:
    "Mutate a file in the current space. Five modes (set `mode` explicitly):\n" +
    "  - create: write a new file. Provide full file content as `content`. Fails if the file already exists.\n" +
    "  - append: add to the end of an existing file. Provide the new material as `content`.\n" +
    "  - replace: Aider-style SEARCH/REPLACE. `search` must match exactly once. Use for surgical in-place edits like updating a frontmatter line.\n" +
    "  - annotate: splice `insert_text` immediately after a unique `insert_after_phrase`. Everything else stays byte-for-byte identical. Prefer this over `replace` when you are adding an observation to an existing wiki — the schema makes it impossible to accidentally rewrite surrounding prose.\n" +
    "  - delete_section: remove an ATX heading line and its body, up to the next same-or-higher heading. Pass the literal heading line as `heading` (e.g. '## Open threads'). Heading must match exactly once.\n" +
    "Whole-file deletion is a separate tool (`delete_wiki`).",
  inputSchema: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("create"),
      path: z.string().describe("Relative path inside the space's watch_dir."),
      content: z.string().describe("Full file content (frontmatter + body)."),
    }),
    z.object({
      mode: z.literal("append"),
      path: z.string().describe("Relative path inside the space's watch_dir."),
      content: z.string().describe("Material to append at the end of the file."),
    }),
    z.object({
      mode: z.literal("replace"),
      path: z.string().describe("Relative path inside the space's watch_dir."),
      search: z
        .string()
        .min(1)
        .describe("Exact span to substitute. Must match exactly once."),
      replace: z.string().describe("Substitute content."),
    }),
    z.object({
      mode: z.literal("annotate"),
      path: z.string().describe("Relative path inside the space's watch_dir."),
      insert_after_phrase: z
        .string()
        .min(1)
        .describe(
          "Anchor phrase already in the file (must match exactly once). " +
            "The runtime inserts `insert_text` immediately after this phrase " +
            "and preserves everything else byte-for-byte.",
        ),
      insert_text: z
        .string()
        .describe("Text to splice in directly after the anchor phrase."),
    }),
    z.object({
      mode: z.literal("delete_section"),
      path: z.string().describe("Relative path inside the space's watch_dir."),
      heading: z
        .string()
        .min(1)
        .describe(
          "ATX heading line to delete (e.g. '## Open threads'). The runtime " +
            "removes this heading and its body up to (but not including) the " +
            "next heading at the same or higher level. Must match exactly once.",
        ),
    }),
  ]),
  call: async (input, ctx) => {
    if (input.mode === "create") {
      const absPath = safeResolve(ctx.space.watch_dir, input.path);
      if (existsSync(absPath)) {
        throw new Error(
          `edit_file: ${input.path} already exists — use mode 'append', 'annotate', 'replace', or 'delete_section' to modify it`,
        );
      }
      const result = await ctx.applyEdit(
        { kind: "write", path: input.path, content: input.content },
        { edit_kind: "create" },
      );
      return { path: result.path, mode: "create" as const };
    }

    if (input.mode === "append") {
      const absPath = safeResolve(ctx.space.watch_dir, input.path);
      if (!existsSync(absPath)) {
        throw new Error(
          `edit_file: ${input.path} does not exist — use mode 'create' to write a new file`,
        );
      }
      const current = readFileSync(absPath, "utf-8");
      const joined =
        current.endsWith("\n") || current.length === 0
          ? current + input.content
          : current + "\n" + input.content;
      const result = await ctx.applyEdit(
        { kind: "write", path: input.path, content: joined },
        { edit_kind: "append" },
      );
      return { path: result.path, mode: "append" as const };
    }

    if (input.mode === "replace") {
      const result = await ctx.applyEdit(
        {
          kind: "edit",
          path: input.path,
          search: input.search,
          replace: input.replace,
        },
        { edit_kind: "replace" },
      );
      return { path: result.path, mode: "replace" as const };
    }

    if (input.mode === "annotate") {
      const result = await ctx.applyEdit(
        {
          kind: "annotate",
          path: input.path,
          insert_after_phrase: input.insert_after_phrase,
          insert_text: input.insert_text,
        },
        { edit_kind: "annotate" },
      );
      return { path: result.path, mode: "annotate" as const };
    }

    if (input.mode === "delete_section") {
      const result = await ctx.applyEdit(
        {
          kind: "delete_section",
          path: input.path,
          heading: input.heading,
        },
        { edit_kind: "delete_section" },
      );
      return { path: result.path, mode: "delete_section" as const };
    }

    // Discriminated union exhaustiveness check. The Zod schema rejects
    // unknown mode values upstream when the AI SDK validates; this is
    // a defensive guard for callers that bypass validation (e.g. tests
    // calling tool.execute directly).
    const _exhaustive: never = input;
    throw new Error(
      `edit_file: unknown mode '${(_exhaustive as { mode?: string }).mode}'`,
    );
  },
  summarize: (r) => ({ path: r.path, mode: r.mode }),
});

// ── delete_wiki ───────────────────────────────────────────────────

/**
 * Remove a wiki file from disk and its entity from the index.
 *
 * Off-limits to the ingestor by default — the consolidator role uses
 * this to merge a wiki into another and then delete the now-empty
 * source. The convention the consolidator's prompt enforces is "you
 * only delete YOUR OWN subject's wiki, never someone else's", which
 * keeps cascading consolidation runs orderly.
 *
 * `reason` is required and surfaces in the agent trace alongside the
 * tool call. There's no permanent audit row in `entity_edits` because
 * its FK cascades on entity deletion — provenance for deletes lives in
 * `agent_runs` + the structured trace, not in the per-entity history.
 *
 * Restricted to `wiki/**` paths so an agent can never accidentally
 * delete a source file or .arkeon state.
 */
const deleteWikiTool = defineTool("delete_wiki", {
  description:
    "Delete a wiki file from disk and remove it from the index. " +
    "Use this when consolidating: you've folded the subject's content " +
    "into another wiki (via edit_file APPEND on that wiki) and the " +
    "current wiki should no longer exist. Only paths under `wiki/` are " +
    "allowed — you cannot delete source files. The `reason` is recorded " +
    "in the run trace; write it as if it were a commit message.",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Relative path inside the space's watch_dir. Must start with `wiki/`.",
      ),
    reason: z
      .string()
      .min(1)
      .describe(
        "One-line explanation of why this wiki is being deleted (e.g. " +
          "'merged into wiki/concept/lust.md — same subject under different label'). " +
          "Surfaces in the agent trace; future operators read this when " +
          "auditing what the consolidator did.",
      ),
  }),
  call: async ({ path, reason }, ctx) => {
    if (!path.startsWith("wiki/")) {
      throw new Error(
        `delete_wiki: path '${path}' must be under wiki/ (only wiki files can be deleted)`,
      );
    }
    const result = await ctx.applyEdit(
      { kind: "delete", path },
      { edit_kind: "delete", note: reason },
    );
    if (result.kind !== "delete") {
      throw new Error(`delete_wiki: unexpected applyEdit result kind`);
    }
    return {
      path: result.path,
      removed_entity_id: result.removedEntityId,
      reason,
    };
  },
  summarize: (r) => ({
    path: r.path,
    removed_entity_id: r.removed_entity_id,
  }),
});

// ── Registry ──────────────────────────────────────────────────────

export const ALL_TOOLS: Record<string, ToolFactory> = {
  read_file: readFileTool,
  search: searchTool,
  list_entities: listEntitiesTool,
  edit_file: editFileTool,
  delete_wiki: deleteWikiTool,
};
