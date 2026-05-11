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
import { MAX_QUERY_PATTERNS, searchKeyword } from "../lib/search.js";
import { listEntities, parseEntityTypes, type EntityType } from "../lib/entities.js";

import { defineTool, type ToolFactory } from "./define-tool.js";
import { describeAllowed, resolveSpaceArg } from "./space-scope.js";
import type { AgentContext } from "./runtime.js";

// ── space-scope helpers ──────────────────────────────────────────

interface ToolSpace {
  id: string;
  name: string;
  watch_dir: string;
}

/**
 * Resolve which space(s) a tool call should target. The shared
 * decision matrix for `read_file`, `search`, `list_entities`:
 *
 *   - explicit `space` arg → single space (validated; throws if not
 *     in the allowed set, or if a name is ambiguous within it)
 *   - omitted, single-space role → the triggering space (no change
 *     from pre-#99 behaviour)
 *   - omitted, multi-space role → the full allowed set (fan-out)
 *
 * Single-space leniency: when there's only one allowed space, ANY
 * `space` arg falls through to that space — including unrecognized
 * names. The model occasionally invents values like "default" or
 * copies error-message text verbatim into the next call; for a
 * role that can only target one space anyway, treating those as
 * the obvious target is strictly better than burning a step on an
 * error the model has to recover from. Multi-space roles stay strict
 * because there the choice actually matters.
 *
 * Returns the list of spaces to query. The caller maps to ids for
 * the SQL/ripgrep backend and keeps the returned objects to tag
 * result rows with `space` (name) for the LLM.
 */
function resolveToolScope(
  ctx: AgentContext,
  spaceArg: string | undefined,
): ToolSpace[] {
  if (spaceArg !== undefined && spaceArg !== "") {
    if (ctx.allowedSpaces.length <= 1) {
      // Single-space leniency: any value collapses to the one allowed
      // space. Saves the model a wasted step on garbage values.
      return [ctx.space];
    }
    return [resolveSpaceArg(spaceArg, ctx.allowedSpaces)];
  }
  if (ctx.allowedSpaces.length <= 1) {
    return [ctx.space];
  }
  return [...ctx.allowedSpaces];
}

const SPACE_PARAM_DESC =
  "Optional space name or id to scope this call to. Omit on a single-space " +
  "role (the only behaviour before #99) for the triggering space; omit on a " +
  "multi-space role to fan out across every allowed space (results are " +
  "tagged with `space_id` and `space` so you can tell them apart).";

// ── read_file ─────────────────────────────────────────────────────

const readFileTool = defineTool("read_file", {
  description:
    "Read a file from one of the role's allowed spaces. Path is relative " +
    "to that space's watch_dir. For markdown files, parsed YAML " +
    "frontmatter is returned alongside the body. Multi-space roles " +
    "must specify `space` because a path is ambiguous across spaces; " +
    "single-space roles can omit it.",
  inputSchema: z.object({
    path: z.string().describe("Relative path inside the space's watch_dir."),
    space: z.string().optional().describe(SPACE_PARAM_DESC),
  }),
  call: ({ path, space }, ctx) => {
    // read_file points at one file. Fan-out doesn't make sense — if
    // a multi-space agent omits `space`, demand they pick one. Better
    // a clear error than silently reading from the triggering space
    // when the agent meant another.
    //
    // Single-space leniency mirrors resolveToolScope: any `space`
    // value (including garbage like "default" or a verbatim copy of
    // an error message) collapses to the only allowed space. Saves
    // the model a wasted retry without changing semantics — there's
    // only one place the file could have come from.
    let target: ToolSpace;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space !== undefined && space !== "") {
      target = resolveSpaceArg(space, ctx.allowedSpaces);
    } else {
      throw new Error(
        `read_file: this role can read from multiple spaces, so the ` +
          `\`space\` argument is required. Allowed: ${describeAllowed(ctx.allowedSpaces)}.`,
      );
    }

    const absPath = safeResolve(target.watch_dir, path);
    if (!existsSync(absPath)) {
      throw new Error(`read_file: ${path} does not exist in space '${target.name}'`);
    }
    if (statSync(absPath).isDirectory()) {
      throw new Error(`read_file: ${path} is a directory`);
    }
    const content = readFileSync(absPath, "utf-8");
    if (path.endsWith(".md")) {
      const parsed = parseFrontmatter(content);
      return {
        path,
        space_id: target.id,
        space: target.name,
        frontmatter: parsed.properties,
        body: parsed.body,
      };
    }
    return { path, space_id: target.id, space: target.name, content };
  },
  summarize: (r) => {
    const text = "body" in r ? r.body : r.content;
    return {
      path: r.path,
      space_id: r.space_id,
      space: r.space,
      body_chars: text?.length ?? 0,
      has_frontmatter: "frontmatter" in r,
    };
  },
});

// ── search ────────────────────────────────────────────────────────

const searchTool = defineTool("search", {
  description:
    "Search the role's allowed spaces via ripgrep keyword matching. " +
    "Exact substring (or regex) over file contents. Best for proper " +
    "nouns, code identifiers, ULIDs, exact phrases. Pass `query` as " +
    "an array (up to 10) to OR several patterns in a single ripgrep " +
    "pass — useful for variant batching " +
    "(['Shannon', 'Claude Shannon', 'information theorist']). Match " +
    "counts aggregate per file, so files matching multiple variants " +
    "naturally rank higher. Hits are ranked by match count with line " +
    "snippets.\n" +
    "Pass `type` (comma-separated: 'wiki', 'file') to restrict hits " +
    "to a subset of entity types — e.g. `type='file'` to focus on raw " +
    "sources without drowning in wiki hits.\n" +
    "Multi-space roles can pass `space` to scope to one space, or omit " +
    "it to search every allowed space (each hit carries `space_id` and " +
    "`space` so you can tell them apart).",
  inputSchema: z.object({
    query: z
      .union([z.string(), z.array(z.string()).min(1).max(10)])
      .describe(
        "A single query string, or an array of up to 10 patterns OR'd " +
          "together in one ripgrep invocation. All variants share " +
          "ripgrep's --smart-case mode: a single uppercase letter " +
          "anywhere in the array makes the WHOLE batch case-sensitive, " +
          "so prefer all-lowercase variants unless you need case " +
          "discrimination.",
      ),
    type: z
      .string()
      .optional()
      .describe(
        "Comma-separated entity types: any of 'wiki', 'file'. Omit for all types.",
      ),
    regex: z
      .boolean()
      .optional()
      .describe("Treat query as a regex."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max hits. Default 20, cap 200."),
    max_snippets_per_file: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max line snippets per hit (default 3)."),
    space: z.string().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async (
    { query, type, regex, limit, max_snippets_per_file, space },
    ctx,
  ) => {
    let types: EntityType[] | undefined;
    try {
      types = parseEntityTypes(type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`search: ${msg}`);
    }

    if (Array.isArray(query) && query.length > MAX_QUERY_PATTERNS) {
      throw new Error(
        `search: too many query patterns (${query.length}); max is ${MAX_QUERY_PATTERNS}`,
      );
    }

    const targets = resolveToolScope(ctx, space);
    const targetIds = targets.map((s) => s.id);
    const indexById = new Map(targets.map((s) => [s.id, s.name]));

    const raw = await searchKeyword({
      query,
      spaceIds: targetIds,
      types,
      regex,
      limit,
      maxSnippetsPerFile: max_snippets_per_file,
    });

    return {
      query,
      spaces: targets.map((s) => ({ id: s.id, name: s.name })),
      keyword: {
        ...raw,
        hits: raw.hits.map((h) => ({
          ...h,
          space: indexById.get(h.space_id) ?? "",
        })),
      },
    };
  },
  summarize: (r) => {
    const k = r.keyword as { hits?: unknown[]; total?: number } | undefined;
    const spaces = r.spaces as { id: string }[] | undefined;
    return {
      query: r.query,
      target_space_ids: spaces?.map((s) => s.id),
      keyword_hits: k?.hits?.length,
      keyword_total: k?.total,
    };
  },
});

// ── list_entities ─────────────────────────────────────────────────

const listEntitiesTool = defineTool("list_entities", {
  description:
    "List entities in the role's allowed spaces — wikis (realized and " +
    "placeholder) and source files — with structural filters. Use this " +
    "to check whether a subject already has a wiki, find sources you " +
    "haven't cited yet (type=file inbound_max=0), find placeholders that " +
    "need filling (unresolved=true), or surface wikis with open threads " +
    "(has_unresolved_outbound=true). A placeholder is a wiki with no " +
    "file on disk yet — left behind by a [[wikilink]] that no real wiki " +
    "has yet been written for. Returns " +
    "{entities, total, limit, offset, spaces}. Each entity row carries " +
    "`unresolved` (true for placeholders), plus `space_id` and `space` " +
    "so multi-space roles can tell results apart. Pass `space` to scope " +
    "to one space; omit on a multi-space role to fan out across the " +
    "whole allowed set.",
  inputSchema: z.object({
    type: z
      .string()
      .optional()
      .describe(
        "Comma-separated entity types: 'wiki' or 'file'. Omit to include " +
          "both. Placeholders are wikis with no file on disk yet — filter " +
          "with `unresolved` (placeholders are still type='wiki').",
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
        "True: only entities with at least one outbound link to a " +
          "placeholder (i.e. wikis with open threads). False: only " +
          "entities whose outbound links all resolve to realized wikis.",
      ),
    unresolved: z
      .boolean()
      .optional()
      .describe(
        "True: only placeholder wikis (no file on disk yet — left by a " +
          "[[wikilink]] that hasn't been filled in). False: only " +
          "realized rows (file exists). Omit to ignore placeholder status.",
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
          "'human' for filesystem-driven changes, 'writer' for agent edits.",
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
    space: z.string().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async (input, ctx) => {
    let types: EntityType[] | undefined;
    try {
      types = parseEntityTypes(input.type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`list_entities: ${msg}`);
    }
    const targets = resolveToolScope(ctx, input.space);
    const indexById = new Map(targets.map((s) => [s.id, s.name]));
    const result = await listEntities({
      space_ids: targets.map((s) => s.id),
      types,
      subject_type: input.subject_type,
      status: input.status,
      label_contains: input.label_contains,
      inbound_min: input.inbound_min,
      inbound_max: input.inbound_max,
      outbound_min: input.outbound_min,
      outbound_max: input.outbound_max,
      has_unresolved_outbound: input.has_unresolved_outbound,
      unresolved: input.unresolved,
      updated_since: input.updated_since,
      edited_by_role: input.edited_by_role,
      sort: input.sort,
      include_counts: input.include_counts,
      limit: input.limit,
      offset: input.offset,
    });
    return {
      ...result,
      entities: result.entities.map((e) => ({
        ...e,
        space: indexById.get(e.space_id) ?? "",
      })),
      spaces: targets.map((s) => ({ id: s.id, name: s.name })),
    };
  },
  summarize: (r) => {
    const entities = (r as { entities?: unknown[] }).entities;
    const total = (r as { total?: number }).total;
    const spaces = (r as { spaces?: { id: string }[] }).spaces;
    return {
      total,
      returned: Array.isArray(entities) ? entities.length : undefined,
      target_space_ids: spaces?.map((s) => s.id),
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
  // Flat schema (instead of a discriminatedUnion) because OpenAI's
  // Responses API rejects function schemas whose top-level shape isn't
  // `type: "object"` — `discriminatedUnion` compiles to `oneOf`/`anyOf`
  // which fails strict validation. Per-mode field requirements are
  // enforced at the top of `call` instead.
  inputSchema: z.object({
    mode: z
      .enum(["create", "append", "replace", "annotate", "delete_section"])
      .describe(
        "Which kind of edit to perform. Each mode requires a distinct " +
          "set of additional fields — see the tool description for the " +
          "shape of each.",
      ),
    path: z.string().describe("Relative path inside the space's watch_dir."),
    content: z
      .string()
      .optional()
      .describe(
        "REQUIRED when mode='create' (full file content) or mode='append' " +
          "(material to add at the end). Ignored otherwise.",
      ),
    search: z
      .string()
      .optional()
      .describe(
        "REQUIRED when mode='replace'. The exact span to substitute. Must " +
          "match exactly once in the file.",
      ),
    replace: z
      .string()
      .optional()
      .describe("REQUIRED when mode='replace'. The substitute content."),
    insert_after_phrase: z
      .string()
      .optional()
      .describe(
        "REQUIRED when mode='annotate'. Anchor phrase already in the file " +
          "(must match exactly once). The runtime inserts `insert_text` " +
          "immediately after this phrase and preserves everything else " +
          "byte-for-byte.",
      ),
    insert_text: z
      .string()
      .optional()
      .describe(
        "REQUIRED when mode='annotate'. Text to splice in directly after " +
          "the anchor phrase.",
      ),
    heading: z
      .string()
      .optional()
      .describe(
        "REQUIRED when mode='delete_section'. The ATX heading line to delete " +
          "(e.g. '## Open threads'). The runtime removes this heading and its " +
          "body up to (but not including) the next heading at the same or " +
          "higher level. Must match exactly once.",
      ),
  }),
  call: async (input, ctx) => {
    if (input.mode === "create") {
      if (typeof input.content !== "string") {
        throw new Error("edit_file mode='create' requires `content`");
      }
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
      if (typeof input.content !== "string") {
        throw new Error("edit_file mode='append' requires `content`");
      }
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
      if (typeof input.search !== "string" || input.search.length === 0) {
        throw new Error("edit_file mode='replace' requires non-empty `search`");
      }
      if (typeof input.replace !== "string") {
        throw new Error("edit_file mode='replace' requires `replace`");
      }
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
      if (
        typeof input.insert_after_phrase !== "string" ||
        input.insert_after_phrase.length === 0
      ) {
        throw new Error(
          "edit_file mode='annotate' requires non-empty `insert_after_phrase`",
        );
      }
      if (typeof input.insert_text !== "string") {
        throw new Error("edit_file mode='annotate' requires `insert_text`");
      }
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
      if (typeof input.heading !== "string" || input.heading.length === 0) {
        throw new Error(
          "edit_file mode='delete_section' requires non-empty `heading`",
        );
      }
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

    // Defensive exhaustiveness check. Zod's enum validates `mode`
    // upstream; this catches callers that bypass validation (tests
    // calling tool.execute directly with an unknown mode).
    const _exhaustive: never = input.mode;
    throw new Error(
      `edit_file: unknown mode '${String(_exhaustive)}'`,
    );
  },
  summarize: (r) => ({ path: r.path, mode: r.mode }),
});

// ── delete_wiki ───────────────────────────────────────────────────

/**
 * Remove a wiki file from disk and its entity from the index.
 *
 * Not part of the bundled `writer` role's tool whitelist — the
 * create/extend loop never needs deletion. Available for future
 * curator/cleaner roles or for operators who add it to a custom role
 * in `agents.yaml`.
 *
 * `reason` is required and surfaces in the agent trace alongside the
 * tool call. There's no permanent audit row in `entity_edits` because
 * its FK cascades on entity deletion — provenance for deletes lives
 * in the structured trace, not in the per-entity history.
 *
 * Restricted to `wiki/**` paths so an agent can never accidentally
 * delete a source file or .arkeon state.
 */
const deleteWikiTool = defineTool("delete_wiki", {
  description:
    "Delete a wiki file from disk and remove it from the index. " +
    "Only paths under `wiki/` are allowed — you cannot delete source " +
    "files. The `reason` is recorded in the run trace; write it as if " +
    "it were a commit message.",
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
          "auditing what was deleted.",
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
