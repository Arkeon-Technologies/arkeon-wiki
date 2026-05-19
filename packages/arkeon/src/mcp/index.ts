// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./server.js";

// Entrypoint for the `arkeon-wiki mcp` subcommand. Stdio transport only —
// Claude Desktop spawns this as a subprocess and speaks JSON-RPC over
// stdin/stdout. CRITICAL: never console.log on stdio, it corrupts the
// JSON-RPC stream. All logging goes to stderr via console.error.

export async function runStdioServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[arkeon-wiki mcp] connected via stdio");
}
