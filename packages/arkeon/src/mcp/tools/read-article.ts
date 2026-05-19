// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ArkeonWikiClient } from "../client.js";

interface EntityResponse {
  source_path: string;
  label?: string;
  type: string;
  content?: string;
  properties?: Record<string, unknown>;
}

interface ReadResult {
  path: string;
  label?: string;
  properties?: Record<string, unknown>;
  content: string;
  error?: string;
}

export function registerReadArticle(server: McpServer, client: ArkeonWikiClient): void {
  server.registerTool(
    "read_article",
    {
      title: "Read article(s)",
      description:
        "Read the full HTML body of one or more wiki articles (or any indexed entity) in a single parallel batch. `paths` is an array — pass 1-10 source_paths returned by search_wiki / list_articles (e.g. `[\"wiki/photosynthesis.html\", \"wiki/chloroplast.html\"]`). The tool fetches them concurrently and returns one text block per article. Always prefer batching over multiple single-path calls — it eliminates round-trip latency.",
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe(
            "Array of source_paths to read (1-10). Use search_wiki / list_articles to find candidates, then batch the top 1-4 into one call.",
          ),
        space: z.string().nullable().optional().describe("Override the env-bound default space"),
      },
    },
    async ({ paths, space }) => {
      const targetSpace = client.resolveSpace(space ?? undefined);
      const results = await Promise.all(
        paths.map(async (p): Promise<ReadResult> => {
          try {
            const data = await client.getJson<EntityResponse>(`/${targetSpace}/entities/${p}`, {
              include: "content",
            });
            return {
              path: data.source_path,
              label: data.label,
              properties: data.properties,
              content: data.content ?? "<no content returned>",
            };
          } catch (err) {
            return { path: p, content: "", error: String(err) };
          }
        }),
      );

      // One text block per article — easier for the model to parse than a
      // single concatenated dump. Each block is prefixed with the path
      // header so the model can attribute content correctly.
      const content = results.map((r) => ({
        type: "text" as const,
        text: r.error
          ? `# ${r.path}\n\n(error reading: ${r.error})`
          : `# ${r.label ?? r.path}\n_${r.path}_\n\n${r.content}`,
      }));

      return {
        content,
        structuredContent: {
          space: targetSpace,
          articles: results,
        } as unknown as Record<string, unknown>,
      };
    },
  );
}
