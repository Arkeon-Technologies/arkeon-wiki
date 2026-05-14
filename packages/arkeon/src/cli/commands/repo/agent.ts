// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki agent <subcommand>` — agent operations.
 *
 * Subcommands:
 *   run <role>    fire one role on demand (POST /:space/agents/:role/run)
 *
 * The subcommand layout exists so additional verbs (list, watch, ...)
 * can land without re-shaping the CLI surface.
 *
 * `agent run` is the smoke-test entrypoint for the setup flow: change
 * `instructions:` in agents.yaml, then trigger one writer tick to see
 * what the corpus actually produces before letting cron roll. Without
 * this command, the user has to wait for the next cron firing or
 * temporarily edit the cron expression.
 */

import type { Command } from "commander";

import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";

interface AgentRunOptions {
  space?: string;
}

interface AgentRunResponse {
  space: string;
  role: string;
  duration_ms: number;
  steps: number;
  edits: { path: string; kind: string }[];
  skipped: boolean;
  reason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  text: string;
}

export function registerAgentCommand(program: Command): void {
  const cmd = program
    .command("agent")
    .description("Agent operations (run, ...)");

  cmd
    .command("run")
    .argument("<role>", "Role name (editor, proposer, writer, or a custom role)")
    .description("Fire one role on demand and block until it finishes")
    .option("--space <name>", "Space name (default: bound space)")
    .action(async (role: string, options: AgentRunOptions) => {
      try {
        await runAgentCmd(role, options);
      } catch (error) {
        output.error(error, { operation: "agent run" });
        process.exitCode = 1;
      }
    });
}

async function runAgentCmd(
  role: string,
  options: AgentRunOptions,
): Promise<void> {
  const repoState = loadRepoState();
  const apiUrl =
    process.env.ARKE_API_URL ??
    repoState?.api_url ??
    `http://localhost:${DEFAULT_API_PORT}`;

  const space = options.space ?? repoState?.space_name;
  if (!space) {
    throw new Error(
      "agent run: --space is required when not run inside an arkeon-wiki space (no .arkeon/state.json found).",
    );
  }

  // No body needed today — the runtime picks its own work from
  // list_entities / list_redlinks. Future: { trigger_path }.
  const res = await fetch(
    `${apiUrl}/${encodeURIComponent(space)}/agents/${encodeURIComponent(role)}/run`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const errShape = (body as { error?: { message?: string; code?: string } }).error;
    const message = errShape?.message ?? res.statusText;
    const err = new Error(`agent run failed: ${res.status} ${message}`) as Error & {
      code?: string;
      statusCode?: number;
    };
    if (errShape?.code) err.code = errShape.code;
    err.statusCode = res.status;
    throw err;
  }

  const result = (await res.json()) as AgentRunResponse;
  output.result({
    operation: "agent run",
    space: result.space,
    role: result.role,
    duration_ms: result.duration_ms,
    steps: result.steps,
    edit_count: result.edits.length,
    edits: result.edits,
    skipped: result.skipped,
    reason: result.reason,
    usage: result.usage,
  });
}
