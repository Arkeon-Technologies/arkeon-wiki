// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ArkeonWikiClient } from "../client.js";

interface RedlinksResponse {
  redlinks: Array<{
    target_path: string;
    demand: number;
    linked_from: string[];
  }>;
}

export function registerListRedlinks(server: McpServer, client: ArkeonWikiClient, namePrefix = ""): void {
  server.registerTool(
    `${namePrefix}list_redlinks`,
    {
      title: "List red links",
      description:
        "Show the corpus's red-link queue — articles the wiki wants written next, ranked by demand (inbound link count). Useful when the user asks `what does the wiki want me to think about` or before writing a thought that might already be queued.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(15),
        space: z.string().nullable().optional().describe("Override the env-bound default space"),
      },
    },
    async ({ limit, space }) => {
      const targetSpace = client.resolveSpace(space ?? undefined);
      const data = await client.getJson<RedlinksResponse>(`/${targetSpace}/redlinks`, { limit });
      // Red links are by definition articles that don't exist yet, so
      // the `[label](url)` link will be a 404 — but the URL is still
      // useful: it's where the article WOULD live, and clicking it in
      // a browser is the user's signal-of-interest the writer agent
      // already keys off (inbound_max=0 + demand). The `linked_from`
      // articles do exist and should be clickable citations to where
      // the demand came from.
      const text = data.redlinks.length
        ? data.redlinks
            .map((r) => {
              const target = client.markdownLink(targetSpace, r.target_path);
              const sources = r.linked_from
                .slice(0, 3)
                .map((p) => client.markdownLink(targetSpace, p))
                .join(", ");
              return `- ${target} (demand: ${r.demand}; linked from: ${sources})`;
            })
            .join("\n")
        : "No red links queued — the corpus has nothing in the writer's pipeline right now.";
      return {
        content: [{ type: "text", text }],
        structuredContent: { space: targetSpace, redlinks: data.redlinks },
      };
    },
  );
}
