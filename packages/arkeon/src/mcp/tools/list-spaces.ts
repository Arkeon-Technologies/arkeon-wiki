// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ArkeonWikiClient } from "../client.js";

interface SpacesResponse {
  spaces: Array<{
    name: string;
    watch_dir: string;
    created_at: string;
    entity_count?: number;
  }>;
}

export function registerListSpaces(server: McpServer, client: ArkeonWikiClient, namePrefix = ""): void {
  server.registerTool(
    `${namePrefix}list_spaces`,
    {
      title: "List spaces",
      description:
        "List every wiki space registered with the daemon. Returns name, watch_dir, and entity count for each. Use when the user asks `what wikis exist` or before calling create_space (to avoid name collisions).",
      inputSchema: {},
    },
    async () => {
      const data = await client.getJson<SpacesResponse>("/spaces");
      const lines = data.spaces.length
        ? data.spaces.map((s) => `- ${s.name} (${s.entity_count ?? "?"} entities) — ${s.watch_dir}`).join("\n")
        : "No spaces yet. Use create_space to register one.";
      return {
        content: [{ type: "text", text: lines }],
        structuredContent: { spaces: data.spaces },
      };
    },
  );
}
