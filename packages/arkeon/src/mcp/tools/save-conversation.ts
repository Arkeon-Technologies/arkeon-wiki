// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { type ArkeonWikiClient, HttpError } from "../client.js";
import { TOOL_DESCRIPTIONS } from "../flows.js";

interface PutResponse {
  space: string;
  path: string;
  overwrote: boolean;
  entity: { source_hash: string; last_edited_by?: string };
}

function utcStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}-${hh}${mm}`;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "conversation"
  );
}

export function registerSaveConversation(server: McpServer, client: ArkeonWikiClient): void {
  server.registerTool(
    "save_conversation",
    {
      title: "Save conversation",
      description: TOOL_DESCRIPTIONS.save_conversation,
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe("Short slug for the filename (max ~50 chars). Will be lowercased + hyphenated automatically."),
        transcript: z
          .string()
          .min(1)
          .describe(
            "The full markdown transcript. Preserve the exchange verbatim — questions, answers, captures, all of it. Recommended shape: `# Title` then `## Question` / `## Answer` (or `## Round N — Question/Answer` for multi-round).",
          ),
        space: z.string().nullable().optional().describe("Override the env-bound default space"),
      },
    },
    async ({ slug, transcript, space }) => {
      const targetSpace = client.resolveSpace(space ?? undefined);
      const baseSlug = slugify(slug);
      const stamp = utcStamp();
      let suffix = 0;
      let lastError: unknown;
      // Auto-suffix on 409 (path collision). Max 10 attempts — beyond that
      // something is wrong with the slug, surface the error.
      //
      // TOCTOU note: two near-simultaneous saves on the same slug could
      // both probe a free path and one loses the race. Acceptable for the
      // single-user-Desktop case; would matter if this server ever served
      // multiple concurrent clients.
      while (suffix < 10) {
        const slugWithSuffix = suffix === 0 ? baseSlug : `${baseSlug}-${suffix + 1}`;
        const sourcePath = `sources/conversations/${stamp}-${slugWithSuffix}.md`;
        const path = `/${targetSpace}/${sourcePath}`;
        try {
          const data = await client.putRaw<PutResponse>(path, transcript, {
            contentType: "text/markdown",
          });
          return {
            content: [
              {
                type: "text",
                text: `Saved → \`${data.path}\` · view at ${client.entityUrl(targetSpace, sourcePath)}`,
              },
            ],
            structuredContent: data as unknown as Record<string, unknown>,
          };
        } catch (err) {
          lastError = err;
          if (!(err instanceof HttpError && err.status === 409)) throw err;
          suffix += 1;
        }
      }
      throw new Error(`save_conversation: 10 collisions on slug \`${baseSlug}\` — last error: ${lastError}`);
    },
  );
}
