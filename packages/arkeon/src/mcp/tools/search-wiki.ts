// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ArkeonWikiClient } from "../client.js";

interface SearchResponse {
  keyword: {
    hits: Array<{
      source_path: string;
      label?: string;
      match_count: number;
      snippets?: string[];
    }>;
  };
}

export function registerSearchWiki(server: McpServer, client: ArkeonWikiClient): void {
  server.registerTool(
    "search_wiki",
    {
      title: "Search wiki",
      description:
        "Ripgrep search across the space. `q` can be a single string or an array of up to 10 patterns (OR'd in one pass). Returns matching articles ranked by match count. For keyword-mismatch cases (user uses a modern term not in the corpus), fall back to list_articles.",
      inputSchema: {
        q: z
          .union([z.string(), z.array(z.string())])
          .describe("Search query (single string) or up to 10 patterns to OR together"),
        type: z
          .enum(["wiki", "file"])
          .nullable()
          .optional()
          .describe("Filter to wikis only or source files only. Default: both."),
        limit: z.number().int().min(1).max(50).default(10).describe("Max hits"),
        space: z
          .string()
          .nullable()
          .optional()
          .describe("Override the env-bound default space. Usually leave unset."),
      },
    },
    async ({ q, type, limit, space }) => {
      const targetSpace = client.resolveSpace(space ?? undefined);
      const data = await client.getJson<SearchResponse>(`/${targetSpace}/search`, {
        q: Array.isArray(q) ? q : [q],
        type: type ?? undefined,
        limit,
      });
      const hits = data.keyword?.hits ?? [];
      // Emit fully-qualified reader URLs so the model can cite hits
      // directly without first calling daemon_status to learn the port.
      const text = hits.length
        ? hits
            .map(
              (h) =>
                `- ${h.label ?? h.source_path} — ${h.source_path} · ${client.entityUrl(
                  targetSpace,
                  h.source_path,
                )} (matches: ${h.match_count})`,
            )
            .join("\n")
        : "No hits. Try list_articles with `label_contains` if the corpus uses different vocabulary than the query.";
      // structuredContent trimmed: full hit rows carry per-snippet text
      // that the model already consumes through the text block. Keeping
      // both doubled the response size and stressed Claude Desktop's UI
      // on wider corpora.
      const summaries = hits.map((h) => ({
        path: h.source_path,
        label: h.label,
        match_count: h.match_count,
      }));
      return {
        content: [{ type: "text", text }],
        structuredContent: { space: targetSpace, hits: summaries },
      };
    },
  );
}
