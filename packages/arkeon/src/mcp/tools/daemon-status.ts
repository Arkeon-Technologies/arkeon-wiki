// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ArkeonWikiClient } from "../client.js";

export function registerDaemonStatus(server: McpServer, client: ArkeonWikiClient, namePrefix = ""): void {
  server.registerTool(
    `${namePrefix}daemon_status`,
    {
      title: "Daemon status",
      description:
        "Check whether the arkeon-wiki daemon is reachable. Returns ok=true if /health responds, plus the API URL the MCP is configured against. Call this first if anything else fails.",
      inputSchema: {},
    },
    async () => {
      const health = await client.health();
      const message = health.ok
        ? `Daemon OK at ${client.apiUrl} (default space: ${client.defaultSpace ?? "<unset>"})`
        : `Daemon NOT reachable at ${client.apiUrl}. Run \`arkeon-wiki up\` in a terminal and try again.`;
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          ok: health.ok,
          api_url: client.apiUrl,
          default_space: client.defaultSpace ?? null,
          status: health.status,
        },
      };
    },
  );
}
