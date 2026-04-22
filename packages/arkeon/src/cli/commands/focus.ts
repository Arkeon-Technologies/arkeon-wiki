// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon focus` — sync .arkeon/focus.yaml to the space's extraction focus.
 *
 * Reads the per-repo focus.yaml file and pushes it to the server via
 * PUT /spaces/{id}/focus. This is the primary command agents use to
 * configure what the wiki extracts and how it writes.
 */

import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import { apiGet, apiPut, apiDelete } from "../lib/api-client.js";
import { credentials } from "../lib/credentials.js";
import { output } from "../lib/output.js";
import { requireRepoState } from "../lib/repo-state.js";

interface FocusOptions {
  show?: boolean;
  clear?: boolean;
  file?: string;
}

function resolveApiKey(state: { actors: Record<string, { actor_id: string }> }): string {
  const actorId = state.actors.ingestor?.actor_id;
  if (!actorId) throw new Error("No ingestor actor in state. Run `arkeon init` first.");
  return credentials.requireActorKey(actorId);
}

export function registerFocusCommand(program: Command): void {
  program
    .command("focus")
    .description("Sync .arkeon/focus.yaml to the space — configures what workers extract and how they write")
    .option("--show", "Show the current focus prompts from the server")
    .option("--clear", "Clear all focus prompts from the space")
    .option("--file <path>", "Path to focus YAML file (default: .arkeon/focus.yaml)")
    .action(async (opts: FocusOptions) => {
      try {
        const state = requireRepoState();
        const apiKey = resolveApiKey(state);
        const { api_url: apiUrl, space_id: spaceId } = state;

        if (opts.show) {
          const data = await apiGet<{ focus: Record<string, string> }>(
            apiUrl, `/spaces/${spaceId}/focus`, apiKey,
          );
          const focus = data.focus;
          if (Object.keys(focus).length === 0) {
            output.result({ operation: "focus.show", status: "empty", message: "No focus prompts set. Edit .arkeon/focus.yaml and run `arkeon-wiki focus`." });
          } else {
            output.result({ operation: "focus.show", focus });
          }
          return;
        }

        if (opts.clear) {
          await apiDelete(apiUrl, `/spaces/${spaceId}/focus`, apiKey);
          output.result({ operation: "focus.clear", message: "Focus prompts cleared." });
          return;
        }

        // Default: read focus.yaml and push to server
        const focusPath = opts.file ?? join(process.cwd(), ".arkeon", "focus.yaml");
        if (!existsSync(focusPath)) {
          throw new Error(
            `No focus file found at ${focusPath}. Run \`arkeon init\` to create a template, or use --file <path>.`,
          );
        }

        const raw = readFileSync(focusPath, "utf-8");
        let parsed: unknown;
        try {
          parsed = yaml.load(raw);
        } catch (err) {
          throw new Error(`Invalid YAML in ${focusPath}: ${(err as Error).message}`);
        }

        if (!parsed || typeof parsed !== "object") {
          throw new Error(`${focusPath} must be a YAML mapping with worker names as keys.`);
        }

        // Filter out empty strings and non-string values
        const focus: Record<string, string> = {};
        for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof val === "string" && val.trim().length > 0) {
            focus[key] = val.trim();
          }
        }

        if (Object.keys(focus).length === 0) {
          output.result({
            operation: "focus",
            status: "empty",
            message: "All focus prompts are empty. Edit .arkeon/focus.yaml with your prompts, then run again.",
          });
          return;
        }

        const data = await apiPut<{ focus: Record<string, string> }>(
          apiUrl, `/spaces/${spaceId}/focus`, apiKey, focus,
        );

        const workers = Object.keys(data.focus);
        output.result({
          operation: "focus",
          workers_updated: workers,
          message: `Focus applied for ${workers.length} worker(s): ${workers.join(", ")}`,
        });
      } catch (error) {
        output.error(error, { operation: "focus" });
        process.exitCode = 1;
      }
    });
}
