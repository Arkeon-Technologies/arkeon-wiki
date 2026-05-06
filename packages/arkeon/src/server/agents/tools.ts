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
import { listWikis } from "../lib/wikis.js";

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
    "  - vector (sqlite-vec): semantic similarity against wiki chunk " +
    "embeddings. Best for concepts, paraphrased queries, finding related " +
    "wikis you don't have a literal name for.\n" +
    "Default `mode=both` runs both in parallel and returns each result " +
    "set in its own namespace ({keyword, vector}). Pass `mode=keyword` " +
    "or `mode=vector` to scope to one. Vector hits are chunk-level with " +
    "similarity scores in [-1, 1]; keyword hits are entity-level with " +
    "line snippets ranked by match count.",
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
      .describe("Max hits per strategy (default 20)."),
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

// ── list_wikis ────────────────────────────────────────────────────

const listWikisTool = defineTool("list_wikis", {
  description:
    "List wikis in the current space, with optional filters. Use this to " +
    "check whether a subject already has a wiki before creating a new one, " +
    "or to enumerate wikis of a given subject_type. Returns " +
    "{wikis, total, limit, offset}.",
  inputSchema: z.object({
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
        "Case-insensitive substring match on the wiki's label. " +
          "'Baker Street' matches '221B Baker Street', 'Watson' matches " +
          "'John H. Watson'. Use this to check whether a subject " +
          "already exists — try a few variants of the name (last name " +
          "alone, etc.) before deciding to create a new wiki.",
      ),
    sort: z
      .enum(["updated_at", "label"])
      .optional()
      .describe("Default 'updated_at' (newest first)."),
    include_counts: z
      .boolean()
      .optional()
      .describe(
        "Attach incoming/outgoing markdown-link counts per wiki.",
      ),
    limit: z.number().int().positive().optional().describe("Default 100, max 10000."),
    offset: z.number().int().min(0).optional().describe("Pagination offset, default 0."),
  }),
  call: (input, ctx) =>
    listWikis({
      space_id: ctx.space.id,
      subject_type: input.subject_type,
      status: input.status,
      label_contains: input.label_contains,
      sort: input.sort,
      include_counts: input.include_counts,
      limit: input.limit,
      offset: input.offset,
    }),
  summarize: (r) => {
    const wikis = (r as { wikis?: unknown[] }).wikis;
    const total = (r as { total?: number }).total;
    return {
      total,
      returned: Array.isArray(wikis) ? wikis.length : undefined,
    };
  },
});

// ── edit_file ─────────────────────────────────────────────────────

/**
 * One file-mutation tool covers three operations, dispatched on the
 * presence/absence of `search` and whether the file already exists:
 *
 *   - file does NOT exist + search="" → CREATE the file with `replace`
 *     as the full content (frontmatter + body).
 *   - file EXISTS + search=""        → APPEND `replace` to the end of
 *     the file. New material is added; nothing existing is touched.
 *   - file EXISTS + search!=""       → SEARCH/REPLACE: substitute
 *     the span (must match exactly once). Aider-style.
 *
 * No way to overwrite an existing file. If you need to "rename" a
 * wiki's label, use the SEARCH/REPLACE form on the `label:` line in
 * frontmatter — the file path stays the same.
 */
const editFileTool = defineTool("edit_file", {
  description:
    "Mutate a wiki file. Three modes:\n" +
    "  1. CREATE — pass an empty `search` and full file content as `replace` " +
    "when the file doesn't exist yet. Used when you've decided to add a new wiki.\n" +
    "  2. APPEND — pass an empty `search` and the new material as `replace` " +
    "when the file DOES exist. The text gets added at the end of the body.\n" +
    "  3. REPLACE — pass a non-empty `search` (must match exactly once) and " +
    "the substitution as `replace`. Aider-style SEARCH/REPLACE for surgical " +
    "in-place edits, e.g. updating the `label:` frontmatter line. Copy " +
    "whitespace verbatim.\n" +
    "There is no way to overwrite a whole existing file — if you want to " +
    "change a wiki's label, REPLACE just the `label:` line.",
  inputSchema: z.object({
    path: z.string().describe("Relative path inside the space's watch_dir."),
    search: z
      .string()
      .describe(
        "Empty string for CREATE/APPEND, or the exact span to substitute " +
          "for REPLACE. Must match exactly once when non-empty.",
      ),
    replace: z
      .string()
      .describe(
        "The new content: full file body for CREATE, appended text for " +
          "APPEND, or the substitution for REPLACE.",
      ),
  }),
  call: async ({ path, search, replace }, ctx) => {
    if (search === "") {
      const absPath = safeResolve(ctx.space.watch_dir, path);
      if (existsSync(absPath)) {
        // APPEND: read current content, concat, write back via the
        // 'write' primitive. We use applyEdit's write here because
        // it's the deterministic "set this file's full content"
        // operation; the LLM-facing tool never has access to it.
        const current = readFileSync(absPath, "utf-8");
        const joined = current.endsWith("\n") || current.length === 0
          ? current + replace
          : current + "\n" + replace;
        const result = await ctx.applyEdit(
          { kind: "write", path, content: joined },
          { edit_kind: "append" },
        );
        return { path: result.path, mode: "append" };
      }
      // CREATE: write the new file.
      const result = await ctx.applyEdit(
        { kind: "write", path, content: replace },
        { edit_kind: "create" },
      );
      return { path: result.path, mode: "create" };
    }
    // REPLACE: surgical edit.
    const result = await ctx.applyEdit(
      { kind: "edit", path, search, replace },
      { edit_kind: "replace" },
    );
    return { path: result.path, mode: "replace" };
  },
  summarize: (r) => ({ path: r.path, mode: r.mode }),
});

// ── Registry ──────────────────────────────────────────────────────

export const ALL_TOOLS: Record<string, ToolFactory> = {
  read_file: readFileTool,
  search: searchTool,
  list_wikis: listWikisTool,
  edit_file: editFileTool,
};
