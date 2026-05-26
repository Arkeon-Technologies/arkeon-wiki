// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ArkeonWikiClient } from "../client.js";
import { HttpError } from "../client.js";
import { TOOL_DESCRIPTIONS } from "../flows.js";

interface AddSourceResponse {
  space: string;
  path: string;
  url: string;
  media_type: string;
  size_bytes: number;
  entity: { source_hash: string; created_at: string; kind: string };
}

export function registerAddSource(server: McpServer, client: ArkeonWikiClient): void {
  server.registerTool(
    "add_source",
    {
      title: "Add source from URL",
      description: TOOL_DESCRIPTIONS.add_source,
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            "Absolute http:// or https:// URL. The daemon fetches it directly — do NOT pre-fetch via WebFetch and pass the result through capture_thought.",
          ),
        space: z.string().nullable().optional().describe("Override the env-bound default space"),
      },
    },
    async ({ url, space }) => {
      const targetSpace = client.resolveSpace(space ?? undefined);
      let data: AddSourceResponse;
      try {
        data = await client.postJson<AddSourceResponse>(
          `/${targetSpace}/sources/from-url`,
          { url },
        );
      } catch (err) {
        // Surface the daemon's structured failures (415 unsupported media,
        // 502 upstream error, 503 disabled) as tool text so the model can
        // decide whether to fall back to `capture_thought` with pasted
        // text. Re-throwing would mark the tool call failed and lose the
        // server's explanation.
        if (err instanceof HttpError) {
          return {
            content: [
              { type: "text", text: `add_source failed (${err.status}): ${err.body}` },
            ],
            isError: true,
          };
        }
        throw err;
      }

      const link = client.markdownLink(targetSpace, data.path);
      const kindNote =
        data.entity.kind === "asset"
          ? " · binary asset (linkable from articles, not in the editor queue yet)"
          : " · editor picks it up at the next tick";
      return {
        content: [
          {
            type: "text",
            text: `Added → ${link} (${formatBytes(data.size_bytes)} · ${data.media_type})${kindNote}.`,
          },
        ],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
