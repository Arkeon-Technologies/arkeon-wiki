// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared tool registry.
 *
 * Tools post-v0:
 *   - read_file     (line-numbered output for everything; registers in
 *                    ctx.readPaths so edit_file is allowed)
 *   - read_files    (batched read_file, up to 10 paths per call)
 *   - list_entities (path-based; filterable wiki/file listing)
 *   - list_redlinks (link targets without a matching entity)
 *   - get_entity    (single entity with full inbound + outbound edges)
 *   - get_entities  (batched get_entity, up to 10 paths per call)
 *   - search        (keyword via ripgrep)
 *   - edit_file     (insert_at_line | str_replace; read-gated)
 *   - create_file   (new wiki — accepts full HTML or inner fragment)
 *   - delete_wiki   (guarded full-file deletion; not in writer's whitelist)
 *   - tag_entity    (set/clear agent bookkeeping in entities.tags; survives
 *                    file re-syncs, used for per-role processing queues)
 *   - mark_processed (sugar over tag_entity that fills source_hash for you)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

import { z } from "zod";

import { safeResolve, validateWikiHtmlDocument } from "../lib/file-edits.js";
import { rewriteHrefsForWrite } from "../lib/href-rewrite.js";
import { MAX_QUERY_PATTERNS, searchKeyword } from "../lib/search.js";
import {
  deleteEntityTag,
  getEntity,
  listEntities,
  listRedLinks,
  parseEntityKinds,
  parseEntityTypes,
  setEntityTag,
  type EntityDetail,
  type EntityKind,
  type EntityType,
} from "../lib/entities.js";
import { loadSpacesMap } from "../lib/spaces.js";

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
  spaceArg: string | null | undefined,
): Space[] {
  if (spaceArg != null && spaceArg !== "") {
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
 * Build the canonical space-rooted URL form (`/{space}/{path}`) for a
 * path inside the named space. This is what tool outputs surface as
 * `space_url` so the agent can copy it straight into an `<a href>` —
 * the server rewrites that form back to the correct on-disk relative
 * path at write time.
 *
 * Already-canonical inputs (a `target_path` that already starts with
 * `/` because step 4's `resolveHref` widening produced a cross-space
 * pointer) pass through unchanged.
 */
function spaceUrl(spaceName: string, path: string): string {
  if (path.startsWith("/")) return path;
  const segments = path.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(spaceName)}/${segments}`;
}


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
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: ({ path, space }, ctx) => {
    let target: Space;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space != null && space !== "") {
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
      space_url: spaceUrl(target.name, path),
      content: withLineNumbers(raw),
    };
  },
  summarize: (r) => ({
    path: r.path,
    space: r.space,
    body_chars: r.content?.length ?? 0,
  }),
});

// ── read_files (batched) ──────────────────────────────────────────

const MAX_BATCH_READ = 10;

const readFilesTool = defineTool("read_files", {
  description:
    "Batched read_file. Read up to " +
    String(MAX_BATCH_READ) +
    " files in one call. Each successful read registers its path in the " +
    "per-run read-gate just like read_file. Returns an array of results " +
    "in the same order as the input `paths`; failures are per-item " +
    "`{path, error}` rather than aborting the whole call. Use this " +
    "instead of N separate read_file turns when you already know which " +
    "files you need (e.g. all linkers of a red link, multiple sources " +
    "cited by an article).",
  inputSchema: z.object({
    paths: z
      .array(z.string())
      .min(1)
      .max(MAX_BATCH_READ)
      .describe(
        "Relative paths inside the space's watch_dir. 1.." +
          String(MAX_BATCH_READ) +
          " entries.",
      ),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: ({ paths, space }, ctx) => {
    let target: Space;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space != null && space !== "") {
      target = resolveSpaceArg(space, ctx.allowedSpaces);
    } else {
      throw new Error(
        `read_files: this role can read from multiple spaces, so the ` +
          `\`space\` argument is required. Allowed: ${describeAllowed(ctx.allowedSpaces)}.`,
      );
    }

    const results = paths.map((path) => {
      try {
        const absPath = safeResolve(target.watch_dir, path);
        if (!existsSync(absPath)) {
          return {
            path,
            space: target.name,
            error: `does not exist in space '${target.name}'`,
          };
        }
        if (statSync(absPath).isDirectory()) {
          return { path, space: target.name, error: "is a directory" };
        }
        const raw = readFileSync(absPath, "utf-8");
        ctx.readPaths.add(readGateKey(target.name, path));
        return {
          path,
          space: target.name,
          space_url: spaceUrl(target.name, path),
          content: withLineNumbers(raw),
        };
      } catch (err) {
        return {
          path,
          space: target.name,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    return { space: target.name, results };
  },
  summarize: (r) => ({
    space: r.space,
    count: r.results.length,
    ok: r.results.filter((x) => !x.error).length,
    errors: r.results.filter((x) => x.error).length,
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
      .nullable()
      .optional()
      .describe(
        "Comma-separated: 'wiki', 'file'. Pass null (or omit) for all types.",
      ),
    regex: z
      .boolean()
      .nullable()
      .optional()
      .describe("Treat query as a regex. Pass null (or omit) for substring."),
    limit: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Max hits. Pass null (or omit) for the default of 20."),
    max_snippets_per_file: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "Max line snippets per hit. Pass null (or omit) for the default of 3.",
      ),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
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

    const decorated = {
      ...raw,
      hits: raw.hits.map((h) => ({
        ...h,
        space_url: spaceUrl(h.space_name, h.source_path),
      })),
    };

    return {
      query,
      spaces: targets.map((s) => s.name),
      keyword: decorated,
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
    "`source_path`, `space_url` (the canonical `/{space}/{path}` form — " +
    "paste directly into an <a href>), `type`, `kind`, `label`, " +
    "`source_hash`, `properties`, `tags`, and optional " +
    "`counts.inbound`/`counts.outbound`. " +
    "`kind` is 'text' for parsed corpus material (wikis and indexed text " +
    "sources — what enters the editor / proposer / connector queue) or " +
    "'asset' for binary attachments (images, PDFs, audio, video) that get " +
    "entity rows so links resolve but never feed the agents. Pass " +
    "`kind='text'` on any queue query so attachments don't end up in your " +
    "work feed. " +
    "`source_hash` is the " +
    "SHA-256 of the file content at last sync — pass it as the `value` to " +
    "`tag_entity` when marking 'I processed this' so content-change " +
    "invalidation works automatically. `properties` is file-derived " +
    "(rebuilt on every sync from <meta> tags); `tags` is agent-applied " +
    "bookkeeping (set via `tag_entity`) and persists across content edits. " +
    "Filter by `has_tag` / `not_has_tag` / `tag_equals` to drive " +
    "per-role queues (e.g. `not_has_tag='editor.processed_hash'` returns " +
    "sources the editor hasn't seen yet).",
  inputSchema: z.object({
    type: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Comma-separated entity types: 'wiki' or 'file'. Pass null (or omit) for both.",
      ),
    kind: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Comma-separated kinds: 'text' (parsed corpus material — wikis " +
          "and indexed text sources) or 'asset' (binary attachments — " +
          "images, PDFs, audio, video, archives). Queue queries should " +
          "pass `kind='text'` to keep assets out of the work feed; " +
          "queries that look up what attachments an article references " +
          "use `kind='asset'`. Pass null (or omit) for both.",
      ),
    label_contains: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Case-insensitive substring match on the entity's label. Useful " +
          "for checking whether a subject already exists under some variant. " +
          "Pass null (or omit) to skip the filter.",
      ),
    path_contains: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Case-insensitive substring match on `source_path`. Useful for " +
          "filtering to a subdirectory (e.g. 'biology' to narrow articles). " +
          "Pass null (or omit) to skip the filter.",
      ),
    inbound_min: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("Pass null (or omit) to skip the filter."),
    inbound_max: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "Combine with type='file' inbound_max=0 to find sources nothing has cited yet. " +
          "Pass null (or omit) for no upper bound.",
      ),
    outbound_min: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("Pass null (or omit) to skip the filter."),
    outbound_max: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("Pass null (or omit) for no upper bound."),
    updated_since: z
      .string()
      .nullable()
      .optional()
      .describe("ISO timestamp. Pass null (or omit) to skip the filter."),
    edited_by_role: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Filter on the most recent edit's by_role ('writer', 'human', etc.). " +
          "Pass null (or omit) to skip the filter.",
      ),
    has_tag: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Restrict to entities that have this tag key set. " +
          "Pass null (or omit) to skip the filter.",
      ),
    not_has_tag: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Restrict to entities that do NOT have this tag key set. " +
          "Use for 'find untagged-by-me' queue queries (e.g. " +
          "not_has_tag='editor.processed_hash' returns sources the editor " +
          "hasn't seen yet). Pass null (or omit) to skip the filter.",
      ),
    tag_equals: z
      .object({ key: z.string(), value: z.string() })
      .nullable()
      .optional()
      .describe(
        "Restrict to entities where tag `key` equals exactly `value`. " +
          "Use this for free-form tag matching with a literal value. " +
          "For processing markers (where you want the value compared to " +
          "the entity's own source_hash), prefer `tag_current` or " +
          "`tag_outdated` instead. " +
          "Pass null (or omit) to skip the filter.",
      ),
    tag_current: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Restrict to entities where this tag key's value equals the " +
          "entity's CURRENT source_hash — i.e. the entity has been " +
          "processed and the content has not changed since. Use for " +
          "gate conditions in a pipeline (e.g. proposer needs " +
          "tag_current='editor.processed_hash' to ensure the editor " +
          "has finished at the current source content). " +
          "Pass null (or omit) to skip the filter.",
      ),
    tag_outdated: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Restrict to entities where this tag key is ABSENT or its value " +
          "DOES NOT equal the entity's current source_hash — i.e. the " +
          "entity has never been processed OR its content has changed " +
          "since the last pass. This is the canonical 'needs processing' " +
          "queue filter (e.g. tag_outdated='editor.processed_hash' " +
          "returns the editor's full work queue). " +
          "Pass null (or omit) to skip the filter.",
      ),
    sort: z
      .enum(["updated_at", "label", "inbound", "outbound"])
      .nullable()
      .optional()
      .describe("Default 'updated_at' (newest first). Pass null (or omit) for default."),
    include_counts: z
      .boolean()
      .nullable()
      .optional()
      .describe("Pass null (or omit) to skip counts."),
    limit: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Default 100, max 10000. Pass null (or omit) for default."),
    offset: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("Pass null (or omit) for 0."),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async (input, ctx) => {
    let types: EntityType[] | undefined;
    let kinds: EntityKind[] | undefined;
    try {
      types = parseEntityTypes(input.type);
      kinds = parseEntityKinds(input.kind);
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
        kinds,
        label_contains: input.label_contains,
        path_contains: input.path_contains,
        inbound_min: input.inbound_min,
        inbound_max: input.inbound_max,
        outbound_min: input.outbound_min,
        outbound_max: input.outbound_max,
        updated_since: input.updated_since,
        edited_by_role: input.edited_by_role,
        has_tag: input.has_tag,
        not_has_tag: input.not_has_tag,
        tag_equals: input.tag_equals,
        tag_current: input.tag_current,
        tag_outdated: input.tag_outdated,
        sort: input.sort,
        include_counts: input.include_counts,
        limit: input.limit,
        offset: input.offset,
      });
      allEntities.push(...result.entities);
      total += result.total;
    }

    return {
      entities: allEntities.map((e) => ({
        ...e,
        space_url: spaceUrl(e.space_name, e.source_path),
      })),
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
    "`{target_path, space_url, demand, linked_from[]}`, ranked by demand. " +
    "`space_url` is the canonical `/{space}/{path}` form — paste directly " +
    "into the path arg of `create_file` when fulfilling. Use this to find " +
    "the next article worth writing: high `demand` = many existing articles " +
    "want this concept defined. `linked_from` shows the last 3 source " +
    "articles that pointed at the missing target.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Default 100. Pass null (or omit) for default."),
    offset: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("Pass null (or omit) for 0."),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async ({ limit, offset, space }, ctx) => {
    const targets = resolveToolScope(ctx, space);
    const all: Array<{
      space: string;
      target_path: string;
      space_url: string;
      demand: number;
      linked_from: string[];
    }> = [];
    let total = 0;
    for (const t of targets) {
      const result = await listRedLinks({ space_name: t.name, limit, offset });
      for (const rl of result.redlinks) {
        all.push({
          space: t.name,
          space_url: spaceUrl(t.name, rl.target_path),
          ...rl,
        });
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

// ── get_entity ────────────────────────────────────────────────────

const getEntityTool = defineTool("get_entity", {
  description:
    "Fetch a single entity by path with its full link neighborhood. " +
    "Returns the entity row plus `outbound` (every <a href> this article " +
    "emits — INCLUDES red-link targets that don't have an entity row) " +
    "and `inbound` (every article that points an <a href> at this path — " +
    "the citation list). Use this to answer 'who cites this source?' or " +
    "'what does this article connect to?' in one call. Path is relative " +
    "to the space's watch_dir (e.g. 'wiki/foo.html', 'sources/notes.txt'). " +
    "Leading slashes and trailing `#fragment`/`?query` are stripped. " +
    "Returns `{found: false}` if the entity does not exist.",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Relative path inside the space's watch_dir. " +
          "E.g. 'wiki/foo.html' or 'sources/notes.txt'.",
      ),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async ({ path, space }, ctx) => {
    let target: Space;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space != null && space !== "") {
      target = resolveSpaceArg(space, ctx.allowedSpaces);
    } else {
      throw new Error(
        `get_entity: this role can read from multiple spaces, so the ` +
          `\`space\` argument is required. Allowed: ${describeAllowed(ctx.allowedSpaces)}.`,
      );
    }
    const normalized = normalizeEntityPath(path);
    const entity = await getEntity(target.name, normalized);
    if (!entity) {
      return {
        found: false as const,
        path: normalized,
        space: target.name,
      };
    }
    return { found: true as const, entity: decorateEntity(entity) };
  },
  summarize: (r) => {
    if (!r.found) {
      return { found: false, path: r.path, space: r.space };
    }
    return {
      found: true,
      path: r.entity.source_path,
      space: r.entity.space_name,
      type: r.entity.type,
      outbound_count: r.entity.outbound.length,
      inbound_count: r.entity.inbound.length,
    };
  },
});

/**
 * Decorate a fetched entity (plus its inbound/outbound link arrays)
 * with `space_url` fields. Cheaper to do in one place than scatter
 * `spaceUrl(...)` calls through every consumer.
 */
function decorateEntity(entity: EntityDetail) {
  return {
    ...entity,
    space_url: spaceUrl(entity.space_name, entity.source_path),
    outbound: entity.outbound.map((o) => ({
      ...o,
      // target_path is already canonical for cross-space (starts with
      // `/{otherSpace}/...`) — spaceUrl passes those through verbatim;
      // in-space targets get prefixed with the entity's own space.
      space_url: spaceUrl(entity.space_name, o.target_path),
    })),
    inbound: entity.inbound.map((i) => ({
      ...i,
      // Build space_url from the linker's space, NOT the target's —
      // cross-space inbound rows live in the linker's space, and the
      // URL we hand back must point at the source article in its
      // real home (e.g. `/spaceA/wiki/bar.html` when A links into B).
      space_url: spaceUrl(i.space_name, i.source_path),
    })),
  };
}

/**
 * Tolerant normalization for `get_entity` paths. Stored entity paths
 * have no leading slash and no fragment/query; agents (especially
 * OpenAI models) occasionally hand us `/wiki/foo.html` or
 * `wiki/foo.html#section`. Strip those before the SQL lookup so a
 * mostly-right input doesn't silently 404.
 */
function normalizeEntityPath(p: string): string {
  return p.replace(/^\/+/, "").split("#")[0]!.split("?")[0]!;
}

// ── get_entities (batched) ────────────────────────────────────────

const MAX_BATCH_GET_ENTITY = 10;

const getEntitiesTool = defineTool("get_entities", {
  description:
    "Batched get_entity. Fetch up to " +
    String(MAX_BATCH_GET_ENTITY) +
    " entities (with full inbound/outbound neighborhoods) in one call. " +
    "Returns an array of results in the same order as the input `paths`; " +
    "missing entities come back as `{found: false, path}` rather than " +
    "aborting the call. Use when surveying multiple linkers of a red " +
    "link, multiple sources cited by an article, or comparing several " +
    "entities at once.",
  inputSchema: z.object({
    paths: z
      .array(z.string())
      .min(1)
      .max(MAX_BATCH_GET_ENTITY)
      .describe(
        "Relative paths inside the space's watch_dir. 1.." +
          String(MAX_BATCH_GET_ENTITY) +
          " entries.",
      ),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async ({ paths, space }, ctx) => {
    let target: Space;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space != null && space !== "") {
      target = resolveSpaceArg(space, ctx.allowedSpaces);
    } else {
      throw new Error(
        `get_entities: this role can read from multiple spaces, so the ` +
          `\`space\` argument is required. Allowed: ${describeAllowed(ctx.allowedSpaces)}.`,
      );
    }
    const results = await Promise.all(
      paths.map(async (path) => {
        const normalized = normalizeEntityPath(path);
        const entity = await getEntity(target.name, normalized);
        if (!entity) {
          return {
            found: false as const,
            path: normalized,
            space: target.name,
          };
        }
        return { found: true as const, entity: decorateEntity(entity) };
      }),
    );
    return { space: target.name, results };
  },
  summarize: (r) => ({
    space: r.space,
    count: r.results.length,
    found: r.results.filter((x) => x.found).length,
    missing: r.results.filter((x) => !x.found).length,
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
    "delete_wiki (separate tool).\n" +
    "Href handling: hrefs you write in `content` and `new_string` may use " +
    "space-rooted URL form (`/{space}/{path}`) — the server rewrites them " +
    "to correct on-disk relative paths. `old_string` is matched verbatim " +
    "against disk bytes (the already-rewritten relative form), so paste it " +
    "exactly as `read_file` returned it.",
  inputSchema: z.object({
    mode: z.enum(["insert_at_line", "str_replace"]).describe("Which kind of edit."),
    path: z.string().describe("Relative path inside the space's watch_dir."),
    line_number: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "REQUIRED when mode='insert_at_line'. 1-indexed. Pass null (or omit) for str_replace mode.",
      ),
    content: z
      .string()
      .nullable()
      .optional()
      .describe(
        "REQUIRED when mode='insert_at_line'. One or more lines to insert " +
          "BEFORE `line_number`. Use \\n for line breaks. " +
          "Pass null (or omit) for str_replace mode.",
      ),
    old_string: z
      .string()
      .nullable()
      .optional()
      .describe(
        "REQUIRED when mode='str_replace'. The exact span to substitute. " +
          "Must match exactly once. Do NOT include line-number prefixes from read_file output. " +
          "Pass null (or omit) for insert_at_line mode.",
      ),
    new_string: z
      .string()
      .nullable()
      .optional()
      .describe(
        "REQUIRED when mode='str_replace'. The substitute content. " +
          "Pass null (or omit) for insert_at_line mode.",
      ),
  }),
  call: async (input, ctx) => {
    const key = readGateKey(ctx.space.name, input.path);
    if (!ctx.readPaths.has(key)) {
      throw new Error(
        `edit_file: must read_file('${input.path}') before editing it (read-gate is per-run; reads invalidate after each edit).`,
      );
    }

    // The rewriter walks `<a>`, `<img>`, `<link>` in the supplied
    // fragment and translates `/{space}/...` hrefs to on-disk
    // relative paths. `old_string` is intentionally NOT rewritten —
    // it must match disk bytes verbatim (i.e. the already-rewritten
    // relative form the agent just read).
    const spaces = await loadSpacesMap();
    const rewriteOpts = {
      fromPath: input.path,
      spaceName: ctx.space.name,
      spaces,
    };

    if (input.mode === "insert_at_line") {
      if (input.line_number == null || input.content == null) {
        throw new Error("edit_file mode='insert_at_line' requires `line_number` and `content`");
      }
      const content = rewriteHrefsForWrite(input.content, rewriteOpts);
      const result = await ctx.applyEdit(
        {
          kind: "insert_at_line",
          path: input.path,
          line_number: input.line_number,
          content,
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
      const new_string = rewriteHrefsForWrite(input.new_string, rewriteOpts);
      const result = await ctx.applyEdit(
        {
          kind: "str_replace",
          path: input.path,
          old_string: input.old_string,
          new_string,
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
  <meta charset="utf-8">
  <title>Article title as a question</title>
  <meta name="label" content="Article title as a question">
  <meta name="short_description" content="One-sentence summary.">
</head>
<body>
  <h1>Article title as a question</h1>
  <p>Article content with inline <a href="/your-space/sources/foo.txt">citations</a>
  (replace <code>your-space</code> with the actual space name — see role
  prompt or the <code>space_url</code> field on any tool result).</p>
</body>
</html>`;

const createFileTool = defineTool("create_file", {
  description:
    "Create a new wiki article from a complete HTML document. Path must " +
    "start with `wiki/` and end in `.html` (subfolders allowed). `html` " +
    "must be a full document beginning with `<!DOCTYPE html>` or `<html>`, " +
    "containing a `<meta charset>` declaration, a non-empty `<title>`, and " +
    "a `<body>`. Recommended: `<meta name=\"label\">` and " +
    "`<meta name=\"short_description\">` in `<head>` for better metadata. " +
    "Other `<meta name=\"...\">` tags are indexed as entity properties. " +
    "Fails if the path exists or if the HTML is structurally incomplete.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Relative path under `wiki/`, ending in `.html`. E.g. `wiki/photosynthesis.html`."),
    html: z
      .string()
      .describe(
        "Complete HTML document. Must start with `<!DOCTYPE html>` or `<html>`, " +
          "declare a `<meta charset>`, and contain a non-empty `<title>` and a " +
          "`<body>`. Example:\n" +
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
    const spaces = await loadSpacesMap();
    const rewritten = rewriteHrefsForWrite(html, {
      fromPath: path,
      spaceName: ctx.space.name,
      spaces,
    });
    const result = await ctx.applyEdit(
      { kind: "create", path, content: rewritten },
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
      : failure?.reason === "missing-charset"
      ? `create_file: html must declare its encoding via <meta charset="utf-8"> in <head>. Without it, browsers default to Latin-1 and mojibake non-ASCII characters.`
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

// ── tag_entity ────────────────────────────────────────────────────

const tagEntityTool = defineTool("tag_entity", {
  description:
    "Set or update an agent-applied tag on an entity (any wiki or " +
    "source). Tags are key/value pairs in a JSON bag separate from " +
    "`properties` — they persist across content edits and are used for " +
    "processing bookkeeping (e.g. 'editor.processed_hash' set to the " +
    "source_hash that was processed). Idempotent — calling twice with " +
    "the same args is a no-op. Pass `null` as `value` to delete the key " +
    "(empty string is a legitimate value and is stored verbatim). Keys " +
    "are conventionally namespaced with the role name " +
    "('editor.processed_hash', 'proposer.processed_hash') so different " +
    "agents' bookkeeping stays legible.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Relative path of the entity to tag (wiki or source)."),
    key: z
      .string()
      .min(1)
      .describe(
        "Tag key. Conventionally namespaced with the role name " +
          "(e.g. 'editor.processed_hash'). Dotted keys are stored verbatim " +
          "as JSON object keys (not nested paths).",
      ),
    value: z
      .string()
      .nullable()
      .describe(
        "Tag value. Strings only — encode timestamps, hashes, counts as " +
          "strings. Pass `null` to delete the key. Empty string is a " +
          "valid value and is stored as an empty string, not a deletion.",
      ),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async ({ path, key, value, space }, ctx) => {
    // tag_entity always writes to a single space. Mirror edit_file's
    // single-space semantics: explicit space arg or the triggering one.
    let target: Space;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space != null && space !== "") {
      target = resolveSpaceArg(space, ctx.allowedSpaces);
    } else {
      throw new Error(
        `tag_entity: this role can write to multiple spaces, so the ` +
          `\`space\` argument is required. Allowed: ${describeAllowed(ctx.allowedSpaces)}.`,
      );
    }

    const deleted = value === null;
    const matched = deleted
      ? await deleteEntityTag(target.name, path, key)
      : await setEntityTag(target.name, path, key, value);
    if (!matched) {
      throw new Error(
        `tag_entity: no entity at '${path}' in space '${target.name}'`,
      );
    }
    return {
      path,
      space: target.name,
      key,
      value: deleted ? null : value,
      action: deleted ? ("deleted" as const) : ("set" as const),
    };
  },
  summarize: (r) => ({
    path: r.path,
    space: r.space,
    key: r.key,
    action: r.action,
  }),
});

// ── mark_processed ────────────────────────────────────────────────

const markProcessedTool = defineTool("mark_processed", {
  description:
    "Mark that this role has processed an entity at its current content. " +
    "Sugar over `tag_entity` for the canonical 'I did this' pattern — the " +
    "server reads the entity's current `source_hash` and stores it as the " +
    "tag value under key `<role>.processed_hash`. The agent never handles " +
    "the hash itself, eliminating a class of copy-paste bugs. Pair with " +
    "the `tag_outdated` filter on `list_entities` to query 'sources that " +
    "need (re)processing' — content-change invalidation is automatic " +
    "because when a file's bytes change its `source_hash` changes, the " +
    "stored tag no longer matches, and the entity re-enters the queue. " +
    "For free-form (non-hash) tagging, use `tag_entity` instead.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Relative path of the entity to mark (wiki or source)."),
    role: z
      .string()
      .min(1)
      .describe(
        "Role name (e.g. 'editor', 'proposer'). Stored as the tag key " +
          "'<role>.processed_hash'.",
      ),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async ({ path, role, space }, ctx) => {
    let target: Space;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space != null && space !== "") {
      target = resolveSpaceArg(space, ctx.allowedSpaces);
    } else {
      throw new Error(
        `mark_processed: this role can write to multiple spaces, so the ` +
          `\`space\` argument is required. Allowed: ${describeAllowed(ctx.allowedSpaces)}.`,
      );
    }
    const entity = await getEntity(target.name, path);
    if (!entity) {
      throw new Error(
        `mark_processed: no entity at '${path}' in space '${target.name}'`,
      );
    }
    const key = `${role}.processed_hash`;
    const matched = await setEntityTag(
      target.name,
      path,
      key,
      entity.source_hash,
    );
    if (!matched) {
      throw new Error(
        `mark_processed: failed to write tag on '${path}' in space '${target.name}'`,
      );
    }
    return {
      path,
      space: target.name,
      role,
      key,
      source_hash: entity.source_hash,
    };
  },
  summarize: (r) => ({
    path: r.path,
    space: r.space,
    role: r.role,
  }),
});

// ── fetch ────────────────────────────────────────────────────────
//
// Batched URL + local-path fetch tool that surfaces images to the model
// via the runtime's prepareStep image-injection wrapper. Universal-image
// MIMEs (PNG/JPEG/WebP/GIF) are side-buffered into ctx.imageQueue under
// the toolCallId; the runtime drains the queue between steps and splices
// the bytes into a synthetic user message. Text content (HTML / JSON /
// XML / plain text) is returned inline in the tool result, capped so a
// large page doesn't blow the model's input budget.
//
// One tool, two sources: the dispatch is purely on the prefix
// (`^https?://`) so the agent doesn't need to remember which call to
// make. URLs go through the network; everything else is resolved
// relative to the space's watch_dir.
//
// Why this exists at all: only Anthropic's native provider accepts
// images in tool-role messages — every other vision-capable provider
// (OpenAI, Gemini, open-source via Ollama/vLLM/DeepInfra/OpenRouter)
// requires images in user messages. The runtime wrapper translates;
// this tool just queues. See ../runtime.ts:makeImageInjectionPrepareStep.

const MAX_FETCH_TARGETS = 10;
const FETCH_TIMEOUT_MS = 10_000;
const TEXT_BODY_CAP = 32 * 1024; // 32 KB — enough for typical pages

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  // Universal-safe image set
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  // Text — only what the watcher considers text-shaped. (Falls through
  // to a "this is text, inline it" branch in the tool.)
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "text/xml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".log": "text/plain",
  ".rst": "text/x-rst",
};

function mediaTypeFromExt(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = path.slice(idx).toLowerCase();
  return EXT_TO_MEDIA_TYPE[ext] ?? "application/octet-stream";
}

function normalizeMediaType(raw: string | null | undefined): string {
  if (!raw) return "application/octet-stream";
  return raw.split(";")[0]!.trim().toLowerCase();
}

function isTextMediaType(mt: string): boolean {
  if (mt.startsWith("text/")) return true;
  if (mt === "application/json") return true;
  if (mt === "application/xml" || mt === "application/xhtml+xml") return true;
  if (mt === "application/javascript" || mt === "application/typescript") return true;
  return false;
}

const fetchTool = defineTool("fetch", {
  description:
    "Fetch one or more URLs or local files in a single batched call. " +
    "Use this when a source you're reading contains images whose " +
    "content matters to your work — charts, diagrams, screenshots, " +
    "tweets — and you need to see what they actually depict before " +
    "reasoning about the source. Skip decorative images (avatars, " +
    "logos, page chrome, share buttons) — they cost context and add " +
    "nothing.\n\n" +
    "Each target is either a remote URL (http:// or https://) or a " +
    "space-relative path inside the space's watch_dir. Batching is " +
    "the point: pass every image you want to look at in one call " +
    "instead of N separate calls. Results come back in the same " +
    "order as the input.\n\n" +
    "Per-target outcomes:\n" +
    "  - PNG / JPEG / WebP / GIF: the image bytes are attached as a " +
    "user message right after this tool result, so you can see the " +
    "image directly on your next turn. The tool returns a stub with " +
    "media_type + size_bytes for your reference.\n" +
    "  - Text content (HTML / JSON / XML / markdown / plain text): " +
    "the body is returned inline (capped at 32 KB; `truncated: true` " +
    "if cut off).\n" +
    "  - Anything else (PDF, archives, video, unsupported image " +
    "formats like SVG / HEIC / AVIF): a structured error stub. Only " +
    "the four universal image formats above can be viewed today.\n\n" +
    "Per-target failures (404, timeout, unsupported MIME) don't abort " +
    "the batch — they come back as `kind='error'` items in `results[]` " +
    "so the other targets still come through.\n\n" +
    "Path resolution for local targets: when you grab an `<img src>` or " +
    "`<a href>` value out of an HTML file, that path is RELATIVE TO THE " +
    "HTML FILE, not the watch_dir. Pass the HTML file's path as `from` " +
    "and the tool resolves the same way a browser does. Without `from`, " +
    "local paths are interpreted relative to the watch_dir root.\n\n" +
    "Example — HTML at `sources/post.html` contains " +
    "`<img src=\"../images/chart.png\">`. To view it, pass the href " +
    "VERBATIM as the target and set `from` to the HTML's path:\n" +
    "  fetch({ targets: [\"../images/chart.png\"], " +
    "from: \"sources/post.html\" })\n" +
    "The tool resolves to `images/chart.png` (relative to watch_dir). " +
    "If you'd rather pre-resolve and pass `images/chart.png` directly, " +
    "leave `from` unset — both forms work.",
  inputSchema: z.object({
    targets: z
      .array(z.string())
      .min(1)
      .max(MAX_FETCH_TARGETS)
      .describe(
        "URLs or local paths. 1.." +
          String(MAX_FETCH_TARGETS) +
          " entries. For local paths copied straight out of an " +
          "<img src> / <a href> attribute, pair with `from` so they " +
          "resolve correctly.",
      ),
    from: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Optional space-relative path of the file the targets came " +
          "from. When set, each local target is resolved relative to " +
          "this file's directory (browser-style href resolution). " +
          "Use whenever you've pulled paths from an HTML source's " +
          "<img src> / <a href> attributes.",
      ),
    space: z.string().nullable().optional().describe(SPACE_PARAM_DESC),
  }),
  call: async ({ targets, from, space }, ctx, { toolCallId }) => {
    // Local-file targets land in a specific space. Mirror read_file's
    // multi-space contract: explicit `space` arg or the triggering one.
    let target: Space;
    if (ctx.allowedSpaces.length <= 1) {
      target = ctx.space;
    } else if (space != null && space !== "") {
      target = resolveSpaceArg(space, ctx.allowedSpaces);
    } else {
      throw new Error(
        `fetch: this role spans multiple spaces, so the \`space\` ` +
          `argument is required for local paths. Allowed: ${describeAllowed(ctx.allowedSpaces)}.`,
      );
    }

    // All images surfaced from this single call get bundled into one
    // synthetic user message by the runtime wrapper, keyed by the
    // toolCallId the AI SDK assigned this invocation.
    const queuedImages: Array<{
      source: string;
      mediaType: string;
      data: Buffer;
    }> = [];

    const results = await Promise.all(
      targets.map((rawTarget) =>
        fetchOne(rawTarget, ctx, target, queuedImages, from ?? null),
      ),
    );

    if (queuedImages.length > 0) {
      ctx.imageQueue.set(toolCallId, queuedImages);
    }

    return { results, space: target.name };
  },
  summarize: (r) => ({
    space: r.space,
    count: r.results.length,
    images: r.results.filter((x) => x.kind === "image").length,
    text: r.results.filter((x) => x.kind === "text").length,
    errors: r.results.filter((x) => x.kind === "error").length,
  }),
});

/**
 * Fetch a single target (URL or local path) and decide what to do with
 * the bytes. Mutates `imagesOut` for image hits; the caller will commit
 * them to `ctx.imageQueue` keyed by toolCallId once the batched call
 * completes.
 */
async function fetchOne(
  rawTarget: string,
  ctx: AgentContext,
  space: Space,
  imagesOut: Array<{ source: string; mediaType: string; data: Buffer }>,
  from: string | null,
): Promise<FetchResultItem> {
  try {
    if (/^https?:\/\//i.test(rawTarget)) {
      return await fetchRemote(rawTarget, imagesOut);
    }
    return await fetchLocal(rawTarget, ctx, space, imagesOut, from);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { target: rawTarget, kind: "error", error: msg };
  }
}

interface FetchTextItem {
  target: string;
  kind: "text";
  media_type: string;
  size_bytes: number;
  truncated: boolean;
  text: string;
}
interface FetchImageItem {
  target: string;
  kind: "image";
  media_type: string;
  size_bytes: number;
  note: string;
}
interface FetchErrorItem {
  target: string;
  kind: "error";
  error: string;
}
type FetchResultItem = FetchTextItem | FetchImageItem | FetchErrorItem;

async function fetchRemote(
  url: string,
  imagesOut: Array<{ source: string; mediaType: string; data: Buffer }>,
): Promise<FetchResultItem> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    return {
      target: url,
      kind: "error",
      error: `HTTP ${res.status} ${res.statusText}`,
    };
  }
  const mediaType = normalizeMediaType(res.headers.get("content-type"));

  if (SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    const buf = Buffer.from(await res.arrayBuffer());
    imagesOut.push({ source: url, mediaType, data: buf });
    return {
      target: url,
      kind: "image",
      media_type: mediaType,
      size_bytes: buf.byteLength,
      note: "Image attached as a user message after this tool result.",
    };
  }
  if (isTextMediaType(mediaType)) {
    const full = await res.text();
    const truncated = full.length > TEXT_BODY_CAP;
    return {
      target: url,
      kind: "text",
      media_type: mediaType,
      size_bytes: full.length,
      truncated,
      text: truncated ? full.slice(0, TEXT_BODY_CAP) : full,
    };
  }
  return {
    target: url,
    kind: "error",
    error:
      `unsupported media type '${mediaType}' — this tool can view PNG, JPEG, WebP, GIF, or text content`,
  };
}

async function fetchLocal(
  path: string,
  ctx: AgentContext,
  space: Space,
  imagesOut: Array<{ source: string; mediaType: string; data: Buffer }>,
  from: string | null,
): Promise<FetchResultItem> {
  // Normalize the canonical /{space}/... form too — the agent may paste
  // a space_url from a tool result directly into fetch.
  let normalized = path;
  const spacePrefix = `/${space.name}/`;
  if (normalized.startsWith(spacePrefix)) {
    normalized = normalized.slice(spacePrefix.length);
  } else if (normalized.startsWith("/")) {
    normalized = normalized.replace(/^\/+/, "");
  } else if (from) {
    // Browser-style href resolution: resolve `path` against the directory
    // of `from`, then normalize. Lets agents paste raw <img src> /
    // <a href> values from an HTML source without doing the path math
    // themselves. safeResolve below still guards against escapes.
    const fromDir = posix.dirname(from);
    normalized = posix.normalize(posix.join(fromDir, normalized));
  }

  let absPath = safeResolve(space.watch_dir, normalized);
  if (!existsSync(absPath)) {
    // Belt and suspenders: if `from`-relative resolution missed, the
    // model may have already pre-resolved against the watch_dir root.
    // Try that interpretation as a fallback before giving up.
    if (from && path !== normalized && !path.startsWith("/")) {
      const fallback = safeResolve(space.watch_dir, path);
      if (existsSync(fallback)) {
        normalized = path;
        absPath = fallback;
      } else {
        return { target: path, kind: "error", error: `not found: ${normalized}` };
      }
    } else {
      return { target: path, kind: "error", error: `not found: ${normalized}` };
    }
  }
  if (statSync(absPath).isDirectory()) {
    return {
      target: path,
      kind: "error",
      error: `is a directory: ${normalized}`,
    };
  }

  const mediaType = mediaTypeFromExt(normalized);

  if (SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    const buf = readFileSync(absPath);
    imagesOut.push({ source: normalized, mediaType, data: buf });
    return {
      target: path,
      kind: "image",
      media_type: mediaType,
      size_bytes: buf.byteLength,
      note: "Image attached as a user message after this tool result.",
    };
  }
  if (isTextMediaType(mediaType)) {
    const full = readFileSync(absPath, "utf-8");
    // Reading text via fetch counts as a read for the edit-gate too —
    // the agent might decide to edit after viewing.
    ctx.readPaths.add(readGateKey(space.name, normalized));
    const truncated = full.length > TEXT_BODY_CAP;
    return {
      target: path,
      kind: "text",
      media_type: mediaType,
      size_bytes: full.length,
      truncated,
      text: truncated ? full.slice(0, TEXT_BODY_CAP) : full,
    };
  }
  return {
    target: path,
    kind: "error",
    error:
      `unsupported file type for '${normalized}' (media type '${mediaType}') — this tool can view PNG, JPEG, WebP, GIF, or text content`,
  };
}

// ── Registry ──────────────────────────────────────────────────────

export const ALL_TOOLS: Record<string, ToolFactory> = {
  read_file: readFileTool,
  read_files: readFilesTool,
  search: searchTool,
  list_entities: listEntitiesTool,
  list_redlinks: listRedLinksTool,
  get_entity: getEntityTool,
  get_entities: getEntitiesTool,
  edit_file: editFileTool,
  create_file: createFileTool,
  delete_wiki: deleteWikiTool,
  tag_entity: tagEntityTool,
  mark_processed: markProcessedTool,
  fetch: fetchTool,
};
