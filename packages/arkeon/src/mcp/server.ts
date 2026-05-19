// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ArkeonWikiClient, loadConfig } from "./client.js";
import { registerAllPrompts } from "./prompts/index.js";
import { registerAllTools } from "./tools/index.js";

// Shipped to the client during the MCP initialize handshake. Current
// clients (early 2026) don't surface this to the model, but it costs ~80
// tokens and may help once clients do — and it's the canonical place to
// document the prompts the user can invoke.
const INSTRUCTIONS = `arkeon-wiki MCP — read + write to a local arkeon-wiki space.

Six prompts ship the per-mode flow:
  mode-router  Auto-detect ASK / CAPTURE / FETCH / SAVE from the user's input
  new-space    Walk through setting up a fresh wiki space
  ask          Search + read + cite
  capture      Drop a thought into the inbox (verbatim — never summarize)
  fetch        Pull a URL into the inbox
  save         Bundle the current exchange as a source

Nine tools wrap the daemon's HTTP API (search_wiki, read_article, capture_thought, etc.).

The space + API URL are bound via env (ARKEON_WIKI_SPACE, ARKEON_WIKI_URL) so the user doesn't have to thread them through every call.

CRITICAL: when capturing thoughts or saving conversations, preserve content verbatim. Do not summarize, paraphrase, or tighten what the user (or their attachments / pasted sources) says. The wiki's value comes from raw source material reaching the editor agent intact.`;

export function buildServer(client: ArkeonWikiClient = new ArkeonWikiClient(loadConfig())): McpServer {
  const server = new McpServer(
    {
      name: "arkeon-wiki",
      version: "0.1.0",
    },
    {
      instructions: INSTRUCTIONS,
    },
  );
  registerAllTools(server, client);
  registerAllPrompts(server);
  return server;
}
