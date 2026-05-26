// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ArkeonWikiClient } from "../client.js";
import { registerAddSource } from "./add-source.js";
import { registerCaptureThought } from "./capture-thought.js";
import { registerCreateSpace } from "./create-space.js";
import { registerDaemonStatus } from "./daemon-status.js";
import { registerListArticles } from "./list-articles.js";
import { registerListRedlinks } from "./list-redlinks.js";
import { registerListSpaces } from "./list-spaces.js";
import { registerReadArticle } from "./read-article.js";
import { registerSaveConversation } from "./save-conversation.js";
import { registerSearchWiki } from "./search-wiki.js";

/**
 * Prefix that scopes every tool's registered name to a specific wiki
 * space. Required because Claude Desktop's local-MCP tool registry
 * appears to dedupe by bare tool name across stdio servers — without
 * unique names, four `iarpa-wiki` / `augustine-wiki` / `chartbook-wiki`
 * / `opioid-kol-wiki` entries all exposing `list_articles` end up with
 * exactly ONE callable `list_articles` total, arbitrarily routed to
 * one of the servers. Tools that lose the dedup race appear in
 * `tools/list` but can't actually be invoked from that server's
 * conversation context. Empirically confirmed against Claude Desktop
 * 0.x in May 2026.
 *
 * Sanitization rule: any character outside `[a-zA-Z0-9_]` becomes `_`
 * (so "augustine-chesterton" → "augustine_chesterton"). Empty / null
 * space yields the empty prefix, so a vanilla `arkeon-wiki mcp` with
 * no `ARKEON_WIKI_SPACE` set keeps the original bare names — useful
 * for single-server setups where this collision can't happen.
 */
export function toolNamePrefix(space: string | null | undefined): string {
  if (!space) return "";
  const slug = space.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? `${slug}__` : "";
}

export function registerAllTools(server: McpServer, client: ArkeonWikiClient): void {
  const prefix = toolNamePrefix(client.defaultSpace);
  registerDaemonStatus(server, client, prefix);
  registerListSpaces(server, client, prefix);
  registerCreateSpace(server, client, prefix);
  registerSearchWiki(server, client, prefix);
  registerListArticles(server, client, prefix);
  registerReadArticle(server, client, prefix);
  registerListRedlinks(server, client, prefix);
  registerCaptureThought(server, client, prefix);
  registerAddSource(server, client, prefix);
  registerSaveConversation(server, client, prefix);
}
