// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ArkeonWikiClient } from "../client.js";
import { TOOL_DESCRIPTIONS } from "../flows.js";

interface InboxResponse {
  space: string;
  path: string;
  entity: { source_hash: string; created_at: string };
}

export function registerCaptureThought(server: McpServer, client: ArkeonWikiClient): void {
  server.registerTool(
    "capture_thought",
    {
      title: "Capture thought",
      description: TOOL_DESCRIPTIONS.capture_thought,
      inputSchema: {
        title: z
          .string()
          .min(1)
          .describe("Tight title (max ~10 words). Title the subject, not the act of noting it."),
        text: z
          .string()
          .min(1)
          .describe(
            "The full content to capture. Preserve verbatim — do not summarize, paraphrase, or tighten. Include any quoted source material in full and any conversational context that shapes the meaning.",
          ),
        kind: z
          .enum(["md", "txt"])
          .nullable()
          .optional()
          .describe("Format: md (default) supports headings + quotes; txt is plain"),
        space: z.string().nullable().optional().describe("Override the env-bound default space"),
      },
    },
    async ({ title, text, kind, space }) => {
      const targetSpace = client.resolveSpace(space ?? undefined);
      const data = await client.postJson<InboxResponse>(`/${targetSpace}/inbox`, {
        title,
        text,
        kind: kind ?? "md",
      });
      return {
        content: [
          {
            type: "text",
            text: `Captured → \`${data.path}\` · editor picks it up at the next tick.`,
          },
        ],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );
}
