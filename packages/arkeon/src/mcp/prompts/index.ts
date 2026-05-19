// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ASK_FLOW,
  CAPTURE_FLOW,
  FETCH_FLOW,
  MODE_ROUTER,
  NEW_SPACE_FLOW,
  SAVE_FLOW,
} from "../flows.js";

// Each prompt emits a single user-role message containing the flow doc
// for that mode. The user invokes a prompt from Claude Desktop's slash-
// command menu and the model gets the full per-mode instructions in one
// shot — no need to re-derive intent from terse tool descriptions alone.

export function registerAllPrompts(server: McpServer): void {
  server.registerPrompt(
    "mode-router",
    {
      title: "Use the wiki (auto-detect mode)",
      description: "Open-ended entry point. Detects whether to ASK, CAPTURE, FETCH, or SAVE from the user's next message.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: MODE_ROUTER } }],
    }),
  );

  server.registerPrompt(
    "new-space",
    {
      title: "New space — set up a fresh wiki",
      description: "Walks through registering a new arkeon-wiki space: gathers intent, proposes name + path, calls create_space, drafts the instructions: block.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: NEW_SPACE_FLOW } }],
    }),
  );

  server.registerPrompt(
    "ask",
    {
      title: "Ask the wiki",
      description: "Search the corpus and answer with inline citations to articles.",
      argsSchema: {
        question: z.string().describe("The question to ask the wiki").optional(),
      },
    },
    ({ question }) => ({
      messages: [
        { role: "user", content: { type: "text", text: ASK_FLOW } },
        ...(question
          ? [{ role: "user" as const, content: { type: "text" as const, text: `\nUser's question: ${question}` } }]
          : []),
      ],
    }),
  );

  server.registerPrompt(
    "capture",
    {
      title: "Capture a thought",
      description: "Drop a thought, pasted content, or extracted attachment text into the wiki inbox — verbatim.",
      argsSchema: {
        thought: z.string().describe("The thought / content to capture").optional(),
      },
    },
    ({ thought }) => ({
      messages: [
        { role: "user", content: { type: "text", text: CAPTURE_FLOW } },
        ...(thought
          ? [{ role: "user" as const, content: { type: "text" as const, text: `\nContent to capture (preserve verbatim):\n${thought}` } }]
          : []),
      ],
    }),
  );

  server.registerPrompt(
    "save",
    {
      title: "Save this conversation as a source",
      description: "Bundle the current exchange (verbatim) as a markdown source the editor agent weaves into articles.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: SAVE_FLOW } }],
    }),
  );

  server.registerPrompt(
    "fetch",
    {
      title: "Fetch an external source",
      description: "Pull a URL (or search-then-fetch) and land its full text in the wiki inbox.",
      argsSchema: {
        url_or_topic: z.string().describe("A URL to fetch, or a topic to search for").optional(),
      },
    },
    ({ url_or_topic }) => ({
      messages: [
        { role: "user", content: { type: "text", text: FETCH_FLOW } },
        ...(url_or_topic
          ? [{ role: "user" as const, content: { type: "text" as const, text: `\nFetch target: ${url_or_topic}` } }]
          : []),
      ],
    }),
  );
}
