// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";

interface McpOptions {
  apiUrl?: string;
  space?: string;
  caller?: string;
}

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description(
      "Run the MCP server over stdio (for Claude Desktop). Bind a wiki via ARKEON_WIKI_URL / ARKEON_WIKI_SPACE env vars in claude_desktop_config.json.",
    )
    .option("--api-url <url>", "Override ARKEON_WIKI_URL env (default http://localhost:8000)")
    .option("--space <name>", "Override ARKEON_WIKI_SPACE env (default unbound — tools require space arg)")
    .option("--caller <name>", "Override ARKEON_WIKI_CALLER env (default `mcp`)")
    .action(async (opts: McpOptions) => {
      if (opts.apiUrl) process.env.ARKEON_WIKI_URL = opts.apiUrl;
      if (opts.space) process.env.ARKEON_WIKI_SPACE = opts.space;
      if (opts.caller) process.env.ARKEON_WIKI_CALLER = opts.caller;
      try {
        const { runStdioServer } = await import("../../../mcp/index.js");
        await runStdioServer();
      } catch (error) {
        console.error("[arkeon-wiki mcp] fatal:", error);
        process.exit(1);
      }
    });
}
