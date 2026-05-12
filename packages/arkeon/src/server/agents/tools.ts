// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared tool registry.
 *
 * Six tools post-v0:
 *   - read_file     (line-numbered output for everything; registers in
 *                    ctx.readPaths so edit_file is allowed)
 *   - list_entities (path-based; filterable wiki/file listing)
 *   - list_redlinks (link targets without a matching entity)
 *   - search        (keyword via ripgrep)
 *   - edit_file     (insert_at_line | str_replace; read-gated)
 *   - create_file   (new wiki — accepts full HTML or inner fragment)
 *   - delete_wiki   (guarded full-file deletion; not in writer's whitelist)
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import { z } from "zod";

import { safeResolve, validateWikiHtmlDocument } from "../lib/file-edits.js";
import { MAX_QUERY_PATTERNS, searchKeyword } from "../lib/search.js";
import {
  listEntities,
  listRedLinks,
  parseEntityTypes,
  type EntityType,
} from "../lib/entities.js";

import { defineTool, type ToolFactory } from "./define-tool.js";
import { describeAllowed, resolveSpaceArg } from "./space-scope.js";
import { readGateKey, type AgentContext } from "./runtime.js";
import type { Space } from "../lib/sync.js";

// ── helpers ────────────────────────────────────────────────────────

/**
 * Resolve which space(s) a tool call should target.
 *
 *   - explicit `space` arg → single space (validated; throws if not in
 *     the allowed set)
 *   - omitted, single-space role → the triggering space
 *   - omitted, multi-space role → the full allowed set (fan-out)
 *
 * Single-space leniency: when there's only one allowed space, ANY
 * `space` arg falls through to it — saves the model from burning a
 * step on a verbatim "unknown space" error.
 */
function resolveToolScope(
  ctx: AgentContext,
  spaceArg: string | undefined,
): Space[] {
  if (spaceArg !== undefined && spaceArg !== "") {
    if (ctx.allowedSpaces.length <= 1) return [ctx.space];
    return [resolveSpaceArg(spaceArg, ctx.allowedSpaces)];
  }
  if (ctx.allowedSpaces.length <= 1) return [ctx.space];
  return [...ctx.allowedSpaces];
}

const SPACE_PARAM_DESC =
  "Optional space name to scope this call. Omit on a single-space role " +
  "(the triggering space). Omit on a multi-space role to fan out across " +
  "every allowed space (results are tagged with `space` so you can tell " +
  "them apart).";

/**
 * Format a file's content with line-number prefixes for `read_file`.
 * Numbers are reference-only — the LLM uses them with `insert_at_line`
 * but copies bytes verbatim (no prefixes) for `str_replace`.
 */
function withLineNumbers(content: string): string {
  const lines = content.split("\n");
  const pad = String(lines.length).length;
  return lines
    .map((l, i) => `${String(i + 1).padStart(pad, " ")}\t${l}`)
    .join("\n");
}

// ── read_file ─────────────────────────────────────────────────────

const readFileTool = defineTool("read_file", {
  description:
    "Read a file from one of the role's allowed spaces. Path is relative " +
    "to the space's watch_dir. Output is line-numbered for reference (the " +
    "format is `<n>\\t<line>` — line numbers are NOT part of the file). " +
    "You MUST read a file before editing it; edit_file refuses unread paths.",
  inputSchema: z.object({
    path: z.string().describe("Relative path inside the space's watch_dir."),
    space: z.string().optional().describe(SPACE_PARAM_DESC),
  }),
  call: ({ path, space }, ctx) => {
    let target: Space;
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
    const raw = readFileSync(absPath, "utf-8");
    ctx.readPaths.add(readGateKey(target.name, path));
    return {
      path,
      space: target.name,
      content: withLineNumbers(raw),
    };
  },
  summarize: (r) => ({
    path: r.path,
    space: r.space,
    body_chars: r.content?.length ?? 0,
  }),
});

// ── search ────────────────────────────────────────────────────────

const searchTool = defineTool("search", {
  description:
    "Keyword search via ripgrep over the role's allowed spaces. Exact " +
    "substring (or regex) over file contents. Best for proper nouns, " +
    "exact phrases, identifiers. Pass `query` as an array (up to 10) to " +
    "OR several patterns in one ripgrep pass — match counts aggregate so " +
    "files matching multiple variants rank higher. Pass `type` " +
    "(comma-separated: 'wiki', 'file') to restrict hits.",
  inputSchema: z.object({
    query: z
      .union([z.string(), z.array(z.string()).min(1).max(10)])
      .describe(
        "A single query string, or an array of up to 10 patterns OR'd " +
          "together. ripgrep --smart-case: a single uppercase letter " +
          "anywhere makes the WHOLE batch case-sensitive.",
      ),
    type: z
      .string()
      .optional()
      .describe("Comma-separated: 'wiki', 'file'. Omit for all types."),
    regex: z.boolean().optional().describe("Treat query as a regex."),
    limit: z.number().int().positive().optional().describe("Max hits. Default 20."),
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

    const raw = await searchKeyword({
      query,
      spaceNames: targets.map((s) => s.name),
      types,
      regex,
      limit,
      maxSnippetsPerFile: max_snippets_per_file,
    });

    return {
      query,
      spaces: targets.map((s) => s.name),
      keyword: raw,
    };
  },
  summarize: (r) => {
    const k = r.keyword as { hits?: unknown[]; total?: number } | undefined;
    return {
      query: r.query,
      target_spaces: r.spaces,
      keyword_hits: k?.hits?.length,
      keyword_total: k?.total,
    };
  },
});

// ── list_entities ─────────────────────────────────────────────────

const listEntitiesTool = defineTool("list_entities", {
  description:
    "List entities in the role's allowed spaces with structural filters. " +
    "Use to check whether a subject already has a wiki, find unprocessed " +
    "sources (type=file inbound_max=0 → 'nothing links to this file yet'), " +
    "or surface recently-updated articles. Each row carries `space_name`, " +
    "`source_path`, `type`, `label`, `properties`, and optional " +
    "`counts.inbound`/`counts.outbound`.",
  inputSchema: z.object({
    type: z
      .string()
      .optional()
      .describe("Comma-separated entity types: 'wiki' or 'file'. Omit for both."),
    label_contains: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring match on the entity's label. Useful " +
          "for checking whether a subject already exists under some variant.",
      ),
    path_contains: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring match on `source_path`. Useful for " +
          "filtering to a subdirectory (e.g. 'biology' to narrow articles).",
      ),
    inbound_min: z.number().int().min(0).optional(),
    inbound_max: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Combine with type='file' inbound_max=0 to find sources nothing has cited yet.",
      ),
    outbound_min: z.number().int().min(0).optional(),
    outbound_max: z.number().int().min(0).optional(),
    updated_since: z.string().optional().describe("ISO timestamp."),
    edited_by_role: z
      .string()
      .optional()
      .describe("Filter on the most recent edit's by_role ('writer', 'human', etc.)."),
    sort: z
      .enum(["updated_at", "label", "inbound", "outbound"])
      .optional()
      .describe("Default 'updated_at' (newest first)."),
    include_counts: z.boolean().optional(),
    limit: z.number().int().positive().optional().describe("Default 100, max 10000."),
    offset: z.number().int().min(0).optional(),
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

    // Fan out across targets; aggregate.
    const allEntities: Array<Awaited<ReturnType<typeof listEntities>>["entities"][number]> = [];
    let total = 0;
    for (const t of targets) {
      const result = await listEntities({
        space_name: t.name,
        types,
        label_contains: input.label_contains,
        path_contains: input.path_contains,
        inbound_min: input.inbound_min,
        inbound_max: input.inbound_max,
        outbound_min: input.outbound_min,
        outbound_max: input.outbound_max,
        updated_since: input.updated_since,
        edited_by_role: input.edited_by_role,
        sort: input.sort,
        include_counts: input.include_counts,
        limit: input.limit,
        offset: input.offset,
      });
      allEntities.push(...result.entities);
      total += result.total;
    }

    return {
      entities: allEntities,
      total,
      spaces: targets.map((s) => s.name),
    };
  },
  summarize: (r) => ({
    total: r.total,
    returned: Array.isArray(r.entities) ? r.entities.length : undefined,
    target_spaces: r.spaces,
  }),
});

// ── list_redlinks ─────────────────────────────────────────────────

const listRedLinksTool = defineTool("list_redlinks", {
  description:
    "List link targets in this space that have no entity (yet). Returns " +
    "`{target_path, demand, linked_from[]}`, ranked by demand. Use this to " +
    "find the next article worth writing: high `demand` = many existing " +
    "articles want this concept defined. `linked_from` shows the last 3 " +
    "source articles that pointed at the missing target.",
  inputSchema: z.object({
    limit: z.number().int().positive().optional().describe("Default 100."),
    offset: z.number().int().min(0).optional(),
    space: z.string().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async ({ limit, offset, space }, ctx) => {
    const targets = resolveToolScope(ctx, space);
    const all: Array<{ space: string; target_path: string; demand: number; linked_from: string[] }> = [];
    let total = 0;
    for (const t of targets) {
      const result = await listRedLinks({ space_name: t.name, limit, offset });
      for (const rl of result.redlinks) {
        all.push({ space: t.name, ...rl });
      }
      total += result.total;
    }
    return { redlinks: all, total, spaces: targets.map((s) => s.name) };
  },
  summarize: (r) => ({
    total: r.total,
    returned: Array.isArray(r.redlinks) ? r.redlinks.length : undefined,
    target_spaces: r.spaces,
  }),
});

// ── edit_file ─────────────────────────────────────────────────────

const editFileTool = defineTool("edit_file", {
  description:
    "Mutate an existing file in the current space. Two modes (set `mode` " +
    "explicitly):\n" +
    "  - insert_at_line { line_number, content }: insert content BEFORE " +
    "the given line. Existing lines shift down. Pure additive.\n" +
    "  - str_replace { old_string, new_string }: exact-match SEARCH/REPLACE. " +
    "`old_string` must match exactly once.\n" +
    "Mandatory protocol: read_file the path FIRST. After a successful edit, " +
    "the read is invalidated — re-read before your next edit on the same path. " +
    "For new files, use create_file (no read needed). To delete a wiki, use " +
    "delete_wiki (separate tool).",
  inputSchema: z.object({
    mode: z.enum(["insert_at_line", "str_replace"]).describe("Which kind of edit."),
    path: z.string().describe("Relative path inside the space's watch_dir."),
    line_number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("REQUIRED when mode='insert_at_line'. 1-indexed."),
    content: z
      .string()
      .optional()
      .describe(
        "REQUIRED when mode='insert_at_line'. One or more lines to insert " +
          "BEFORE `line_number`. Use \\n for line breaks.",
      ),
    old_string: z
      .string()
      .optional()
      .describe(
        "REQUIRED when mode='str_replace'. The exact span to substitute. " +
          "Must match exactly once. Do NOT include line-number prefixes from read_file output.",
      ),
    new_string: z
      .string()
      .optional()
      .describe("REQUIRED when mode='str_replace'. The substitute content."),
  }),
  call: async (input, ctx) => {
    const key = readGateKey(ctx.space.name, input.path);
    if (!ctx.readPaths.has(key)) {
      throw new Error(
        `edit_file: must read_file('${input.path}') before editing it (read-gate is per-run; reads invalidate after each edit).`,
      );
    }

    if (input.mode === "insert_at_line") {
      if (input.line_number == null || input.content == null) {
        throw new Error("edit_file mode='insert_at_line' requires `line_number` and `content`");
      }
      const result = await ctx.applyEdit(
        {
          kind: "insert_at_line",
          path: input.path,
          line_number: input.line_number,
          content: input.content,
        },
        { edit_kind: "insert_at_line" },
      );
      return {
        path: result.path,
        mode: "insert_at_line" as const,
        note: "line numbers shifted; re-read before next edit",
      };
    }

    if (input.mode === "str_replace") {
      if (input.old_string == null || input.new_string == null) {
        throw new Error("edit_file mode='str_replace' requires `old_string` and `new_string`");
      }
      const result = await ctx.applyEdit(
        {
          kind: "str_replace",
          path: input.path,
          old_string: input.old_string,
          new_string: input.new_string,
        },
        { edit_kind: "str_replace" },
      );
      return {
        path: result.path,
        mode: "str_replace" as const,
        note: "file changed; re-read before next edit",
      };
    }

    const _exhaustive: never = input.mode;
    throw new Error(`edit_file: unknown mode '${String(_exhaustive)}'`);
  },
  summarize: (r) => ({ path: r.path, mode: r.mode }),
});

// ── create_file ───────────────────────────────────────────────────

const CREATE_FILE_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <title>Article title as a question</title>
  <meta name="label" content="Article title as a question">
  <meta name="short_description" content="One-sentence summary.">
</head>
<body>
  <h1>Article title as a question</h1>
  <p>Article content with inline <a href="../sources/foo.md">citations</a>.</p>
</body>
</html>`;

const createFileTool = defineTool("create_file", {
  description:
    "Create a new wiki article from a complete HTML document. Path must " +
    "start with `wiki/` and end in `.html` (subfolders allowed). `html` " +
    "must be a full document beginning with `<!DOCTYPE html>` or `<html>` " +
    "and containing a non-empty `<title>` plus a `<body>`. Recommended: " +
    "include `<meta name=\"label\">` and `<meta name=\"short_description\">` " +
    "in `<head>` for better metadata. Other `<meta name=\"...\">` tags are " +
    "indexed as entity properties. Fails if the path exists or if the HTML " +
    "is structurally incomplete.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Relative path under `wiki/`, ending in `.html`. E.g. `wiki/photosynthesis.html`."),
    html: z
      .string()
      .describe(
        "Complete HTML document. Must start with `<!DOCTYPE html>` or `<html>` " +
          "and contain a non-empty `<title>` and a `<body>`. Example:\n" +
          CREATE_FILE_TEMPLATE,
      ),
  }),
  call: async ({ path, html }, ctx) => {
    if (!path.startsWith("wiki/")) {
      throw new Error(
        `create_file: path '${path}' must be under wiki/ — only wiki articles can be created via this tool.`,
      );
    }
    if (!path.endsWith(".html")) {
      throw new Error(
        `create_file: wiki paths must end in .html (got '${path}')`,
      );
    }
    const failure = validateWikiHtmlDocument(html);
    if (failure) {
      throw new Error(formatCreateFileValidationError(failure, html));
    }
    const result = await ctx.applyEdit(
      { kind: "create", path, content: html },
      { edit_kind: "create" },
    );
    return { path: result.path, mode: "create" as const };
  },
  summarize: (r) => ({ path: r.path, mode: r.mode }),
});

function formatCreateFileValidationError(
  failure: ReturnType<typeof validateWikiHtmlDocument>,
  html: string,
): string {
  const preview = html.trimStart().slice(0, 120).replace(/\s+/g, " ");
  const head =
    failure?.reason === "missing-wrapper"
      ? `create_file: html must be a complete HTML document — expected '<!DOCTYPE html>' or '<html>' at the top. Got: "${preview}…"`
      : failure?.reason === "missing-title"
      ? `create_file: html must contain a <title> element inside <head>.`
      : failure?.reason === "empty-title"
      ? `create_file: <title> element is empty — supply a non-empty title (becomes entities.label).`
      : `create_file: html must contain a <body> element.`;
  return `${head}\n\nUse this template:\n${CREATE_FILE_TEMPLATE}`;
}

// ── delete_wiki ───────────────────────────────────────────────────

const deleteWikiTool = defineTool("delete_wiki", {
  description:
    "Delete a wiki file and remove it from the index. Only paths under " +
    "`wiki/` are allowed. `reason` is recorded in the agent trace — write " +
    "it like a commit message. Not in the writer's whitelist; available " +
    "to operators and future curator roles.",
  inputSchema: z.object({
    path: z.string().describe("Relative path. Must start with `wiki/`."),
    reason: z
      .string()
      .min(1)
      .describe("One-line explanation. Surfaces in the agent trace and audit log."),
  }),
  call: async ({ path, reason }, ctx) => {
    if (!path.startsWith("wiki/")) {
      throw new Error(
        `delete_wiki: path '${path}' must be under wiki/ — only wikis can be deleted.`,
      );
    }
    const result = await ctx.applyEdit(
      { kind: "delete", path },
      { edit_kind: "delete", note: reason },
    );
    return {
      path: result.path,
      mode: "delete" as const,
      reason,
    };
  },
  summarize: (r) => ({ path: r.path, mode: r.mode }),
});

// ── Registry ──────────────────────────────────────────────────────

export const ALL_TOOLS: Record<string, ToolFactory> = {
  read_file: readFileTool,
  search: searchTool,
  list_entities: listEntitiesTool,
  list_redlinks: listRedLinksTool,
  edit_file: editFileTool,
  create_file: createFileTool,
  delete_wiki: deleteWikiTool,
};
