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

export function registerListRedlinks(server: McpServer, client: ArkeonWikiClient): void {
  server.registerTool(
    "list_redlinks",
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
      const text = data.redlinks.length
        ? data.redlinks
            .map((r) => `- ${r.target_path} (demand: ${r.demand}; linked from: ${r.linked_from.slice(0, 3).join(", ")})`)
            .join("\n")
        : "No red links queued — the corpus has nothing in the writer's pipeline right now.";
      return {
        content: [{ type: "text", text }],
        structuredContent: { space: targetSpace, redlinks: data.redlinks },
      };
    },
  );
}
