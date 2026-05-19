// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ArkeonWikiClient } from "../client.js";

interface EntitiesResponse {
  entities: Array<{
    source_path: string;
    label?: string;
    type: string;
    properties?: Record<string, unknown>;
  }>;
}

export function registerListArticles(server: McpServer, client: ArkeonWikiClient): void {
  server.registerTool(
    "list_articles",
    {
      title: "List articles",
      description:
        "List wiki articles (type=wiki) with metadata, optionally filtered by label substring. Use as an ASK fallback when keyword search misses paraphrase (e.g. the user asks about \"AI girlfriends\" but the corpus titles them \"artificial companionship\"). Returns label + short_description so you can pick which to read.",
      inputSchema: {
        label_contains: z
          .string()
          .nullable()
          .optional()
          .describe("Case-insensitive substring match on the article label"),
        limit: z.number().int().min(1).max(100).default(25),
        space: z.string().nullable().optional().describe("Override the env-bound default space"),
      },
    },
    async ({ label_contains, limit, space }) => {
      const targetSpace = client.resolveSpace(space ?? undefined);
      const data = await client.getJson<EntitiesResponse>(`/${targetSpace}/entities`, {
        type: "wiki",
        label_contains: label_contains ?? undefined,
        limit,
      });
      const text = data.entities.length
        ? data.entities
            .map((e) => {
              const desc = (e.properties?.short_description as string | undefined) ?? "";
              const url = client.entityUrl(targetSpace, e.source_path);
              return `- ${e.label ?? e.source_path} — ${e.source_path} · ${url}${desc ? `\n    ${desc}` : ""}`;
            })
            .join("\n")
        : "No matching articles. Try search_wiki with a different query, or check list_redlinks for what the corpus wants written next.";
      return {
        content: [{ type: "text", text }],
        structuredContent: { space: targetSpace, entities: data.entities },
      };
    },
  );
}
