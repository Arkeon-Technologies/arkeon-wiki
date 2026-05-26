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

export function registerAllTools(server: McpServer, client: ArkeonWikiClient): void {
  registerDaemonStatus(server, client);
  registerListSpaces(server, client);
  registerCreateSpace(server, client);
  registerSearchWiki(server, client);
  registerListArticles(server, client);
  registerReadArticle(server, client);
  registerListRedlinks(server, client);
  registerCaptureThought(server, client);
  registerAddSource(server, client);
  registerSaveConversation(server, client);
}
