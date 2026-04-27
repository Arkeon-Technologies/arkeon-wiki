// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared tool registry.
 *
 * Each entry wires a library function (or a deterministic helper like
 * `contribute`) into the agent runtime. Roles list tool names; the
 * runtime instantiates each named factory with the AgentContext.
 *
 * Adding a new tool: one entry here. The cost is the description and
 * the Zod input schema, not the registration line.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { contribute } from "../lib/contributions.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { search as ripgrepSearch } from "../lib/search.js";

import { defineTool, type ToolFactory } from "./define-tool.js";

// ── read_file ─────────────────────────────────────────────────────

const readFileTool = defineTool("read_file", {
  description:
    "Read a file from the current space. Path is relative to the space's watch_dir. " +
    "For markdown files, parsed YAML frontmatter is returned alongside the body.",
  readOnly: true,
  inputSchema: z.object({
    path: z.string().describe("Relative path inside the space's watch_dir."),
  }),
  call: ({ path }, ctx) => {
    const absPath = join(ctx.space.watch_dir, path);
    if (!existsSync(absPath)) {
      throw new Error(`read_file: ${path} does not exist`);
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
});

// ── search ────────────────────────────────────────────────────────

const searchTool = defineTool("search", {
  description:
    "Keyword-search markdown content in the current space using ripgrep. " +
    "Returns ranked entity hits with line snippets. Use this to find related " +
    "wikis or source files before deciding what to contribute or edit.",
  readOnly: true,
  inputSchema: z.object({
    query: z.string().describe("The substring or regex to search for."),
    regex: z.boolean().optional().describe("Treat query as a regex (default false)."),
    limit: z.number().int().positive().optional().describe("Max hits (default 20)."),
    max_snippets_per_file: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max line snippets per matching file (default 3)."),
  }),
  call: ({ query, regex, limit, max_snippets_per_file }, ctx) =>
    ripgrepSearch({
      query,
      spaceId: ctx.space.id,
      regex,
      limit,
      maxSnippetsPerFile: max_snippets_per_file,
    }),
});

// ── edit_file ─────────────────────────────────────────────────────

const editFileTool = defineTool("edit_file", {
  description:
    "Replace a unique span in an existing file (Aider-style SEARCH/REPLACE). " +
    "The `search` string MUST appear exactly once in the file. " +
    "Use the smallest unique anchor; copy whitespace verbatim.",
  inputSchema: z.object({
    path: z.string().describe("Relative path inside the space's watch_dir."),
    search: z.string().describe("The exact span to replace; must match exactly once."),
    replace: z.string().describe("The text that replaces the matched span."),
  }),
  call: async ({ path, search, replace }, ctx) => {
    const result = await ctx.applyEdit({ kind: "edit", path, search, replace });
    return { path: result.path, applied: true };
  },
});

// ── write_file ────────────────────────────────────────────────────

const writeFileTool = defineTool("write_file", {
  description:
    "Create or overwrite a file with the given content. Use for net-new files " +
    "(e.g. a fresh placeholder wiki); prefer edit_file for modifying existing ones.",
  inputSchema: z.object({
    path: z.string().describe("Relative path inside the space's watch_dir."),
    content: z.string().describe("Full file contents."),
  }),
  call: async ({ path, content }, ctx) => {
    const result = await ctx.applyEdit({ kind: "write", path, content });
    return { path: result.path, applied: true };
  },
});

// ── contribute ────────────────────────────────────────────────────

const contributeTool = defineTool("contribute", {
  description:
    "Route a (subject, excerpt, claim) triple to the right wiki. Matches an " +
    "existing wiki by exact label/alias if one exists; otherwise creates a " +
    "placeholder under wiki/{subject_type}/{slug}.md. The contribution is " +
    "appended to the target wiki's frontmatter `contributions[]` array.",
  inputSchema: z.object({
    subject: z.object({
      label: z.string().describe("Canonical subject name, e.g. 'Claude Shannon'."),
      subject_type: z
        .string()
        .optional()
        .describe("Semantic type, e.g. 'person', 'organization', 'concept'."),
      aliases: z
        .array(z.string())
        .optional()
        .describe("Alternate forms to try when matching existing wikis."),
    }),
    excerpt: z
      .string()
      .describe("Verbatim or near-verbatim quote from the source."),
    claim: z
      .string()
      .optional()
      .describe("Optional one-line summary of what the excerpt establishes."),
    source_id: z
      .string()
      .optional()
      .describe("Entity id of the source file this excerpt came from."),
  }),
  call: ({ subject, excerpt, claim, source_id }, ctx) =>
    contribute({
      space_id: ctx.space.id,
      source_id: source_id ?? null,
      subject,
      excerpt,
      claim,
    }),
});

// ── Registry ──────────────────────────────────────────────────────

export const ALL_TOOLS: Record<string, ToolFactory> = {
  read_file: readFileTool,
  search: searchTool,
  edit_file: editFileTool,
  write_file: writeFileTool,
  contribute: contributeTool,
};
