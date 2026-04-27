// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent runtime: the shared loop that powers the contributor, editor,
 * and any future role.
 *
 * A role describes:
 *   - which model to call          (ModelConfig)
 *   - what prompt to send          (buildPrompt)
 *   - what tools the LLM can use   (a list of names from the registry)
 *   - how to key idempotency       (so re-triggers on the same input
 *                                    with the same hash are skipped)
 *   - how to key concurrency       (so two runs targeting the same
 *                                    wiki/source serialize)
 *
 * The runtime owns: locking, idempotency lookup, tool wiring, the AI
 * SDK call, and persistence of the run record. Roles stay tiny.
 */

import { createHash } from "node:crypto";

import { generateText, stepCountIs, type LanguageModel, type Tool } from "ai";

import { applyEdit, type ApplyEditResult, type FileEdit } from "../lib/file-edits.js";
import { withPathLock } from "../lib/path-lock.js";
import { createSql } from "../lib/sql.js";
import { type Space } from "../lib/sync.js";

import { resolveModel, type ModelConfig } from "./model.js";

// ── Types ─────────────────────────────────────────────────────────

export interface AgentContext {
  space: Space;
  role: string;
  edits: ApplyEditResult[];
  applyEdit(edit: FileEdit): Promise<ApplyEditResult>;
  log(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void;
}

export type ToolFactory = (ctx: AgentContext) => Tool;
export type ToolRegistry = Record<string, ToolFactory>;

export interface AgentInput {
  space: Space;
  triggerPath?: string;
  triggerEntityId?: string;
  meta?: Record<string, unknown>;
}

export interface IdempotencyKey {
  /** Stable identifier for "what was triggered" (e.g. a wiki id, source path). */
  key: string;
  /** Hash of the inputs the agent will see. Detects "same trigger, new content". */
  hash: string;
}

export interface AgentRole {
  name: string;
  model: ModelConfig;
  /** Tool names looked up in the registry passed to runAgent. */
  tools: string[];
  /** Default 10. Caps the tool-use loop so a runaway agent can't churn forever. */
  maxSteps?: number;
  buildPrompt(input: AgentInput): Promise<{ system: string; prompt: string }>;
  idempotencyKey(input: AgentInput): IdempotencyKey;
  concurrencyKey(input: AgentInput): string;
}

export interface AgentRunResult {
  skipped: boolean;
  reason?: string;
  edits: ApplyEditResult[];
  text: string;
  steps: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

// ── Public entry point ────────────────────────────────────────────

export async function runAgent(
  role: AgentRole,
  input: AgentInput,
  registry: ToolRegistry,
): Promise<AgentRunResult> {
  return withPathLock(role.concurrencyKey(input), async () => {
    const idem = role.idempotencyKey(input);
    if (await alreadyProcessed(role.name, idem)) {
      return { skipped: true, reason: "already_processed", edits: [], text: "", steps: 0 };
    }

    const ctx = makeContext(input.space, role.name);
    const { system, prompt } = await role.buildPrompt(input);

    const tools: Record<string, Tool> = {};
    for (const name of role.tools) {
      const factory = registry[name];
      if (!factory) {
        throw new Error(`Unknown tool '${name}' requested by role '${role.name}'`);
      }
      tools[name] = factory(ctx);
    }

    try {
      const result = await generateText({
        model: resolveModel(role.model) as LanguageModel,
        system,
        prompt,
        tools,
        stopWhen: stepCountIs(role.maxSteps ?? 10),
      });

      await markProcessed(role.name, idem, "completed", null);

      return {
        skipped: false,
        edits: ctx.edits,
        text: result.text,
        steps: result.steps?.length ?? 1,
        usage: {
          inputTokens: result.totalUsage?.inputTokens,
          outputTokens: result.totalUsage?.outputTokens,
          totalTokens: result.totalUsage?.totalTokens,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markProcessed(role.name, idem, "failed", msg);
      throw err;
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────

export function makeContext(space: Space, role: string): AgentContext {
  const edits: ApplyEditResult[] = [];
  return {
    space,
    role,
    edits,
    applyEdit: async (edit) => {
      const result = await applyEdit(space, edit);
      edits.push(result);
      return result;
    },
    log: (level, msg, meta) => {
      const tail = meta ? ` ${JSON.stringify(meta)}` : "";
      console.log(`[agent/${role}/${level}] ${msg}${tail}`);
    },
  };
}

/**
 * Deterministic hash of an arbitrary JSON-serializable value. Used to
 * decide whether a re-trigger represents new work.
 */
export function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input ?? null))
    .digest("hex");
}

// ── Idempotency table ─────────────────────────────────────────────

export async function alreadyProcessed(
  role: string,
  idem: IdempotencyKey,
): Promise<boolean> {
  const sql = createSql();
  const rows = await sql`
    SELECT input_hash, status FROM agent_runs
    WHERE role = ${role} AND idempotency_key = ${idem.key}
  `;
  if (rows.length === 0) return false;
  const row = rows[0];
  return row.status === "completed" && row.input_hash === idem.hash;
}

export async function markProcessed(
  role: string,
  idem: IdempotencyKey,
  status: "completed" | "failed",
  error: string | null,
): Promise<void> {
  const sql = createSql();
  await sql`
    INSERT INTO agent_runs (role, idempotency_key, input_hash, status, error)
    VALUES (${role}, ${idem.key}, ${idem.hash}, ${status}, ${error})
    ON CONFLICT(role, idempotency_key) DO UPDATE SET
      input_hash = excluded.input_hash,
      status = excluded.status,
      finished_at = datetime('now'),
      error = excluded.error
  `;
}
