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

import { createHash, randomUUID } from "node:crypto";

import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from "ai";

import {
  applyEdit,
  type ApplyEditResult,
  type FileEdit,
} from "../lib/file-edits.js";
import type { EditKind } from "../lib/edit-context.js";
import { withPathLock } from "../lib/path-lock.js";
import { createSql } from "../lib/sql.js";
import { type Space } from "../lib/sync.js";

import { resolveModel, type ModelConfig } from "./model.js";
import { getTracer, truncateForTrace, type Tracer } from "./tracer.js";

// ── Types ─────────────────────────────────────────────────────────

/**
 * Per-call attribution that the tool layer supplies to AgentContext.applyEdit.
 * The role is implied by the context (whoever owns the AgentContext) so the
 * tool layer only has to specify the semantic edit_kind and an optional note.
 */
export interface ToolEditOpts {
  edit_kind: EditKind;
  note?: string;
}

export interface AgentContext {
  space: Space;
  role: string;
  /** Stable identifier for this run, threaded through every trace event
   *  emitted by tools, edits, and the runtime itself. Random UUID per
   *  invocation of `runAgent`. */
  runId: string;
  /** Name of the phase the runtime is currently executing, or `null`
   *  when no phase is active (e.g. during run.start before phase 0).
   *  Mutable so tools can read the current phase at call time. */
  currentPhase: string | null;
  edits: ApplyEditResult[];
  applyEdit(edit: FileEdit, opts: ToolEditOpts): Promise<ApplyEditResult>;
  log(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void;
  /** Emit a structured trace event. No-op when tracing is disabled.
   *  Auto-fills run_id, role, space_id, and phase. */
  trace(event: string, fields?: Record<string, unknown>): void;
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

/**
 * One stage of a multi-phase run. The runtime walks phases in order
 * within a single conversation, preserving message history across
 * boundaries — phase N+1 sees every tool call and result from phase N.
 *
 * Most roles are single-phase. Phases let a role separate distinct
 * sub-tasks (e.g. an ingestor that first surveys what exists, then
 * writes/edits) and optionally swap models per phase (cheap for
 * gathering, strong for writing).
 */
export interface AgentPhase {
  /** Surfaced in logs / traces. */
  name: string;
  /** User-message prompt added when this phase begins. The first
   *  phase's prompt is the initial user message; subsequent phases'
   *  prompts are appended to the same conversation. */
  prompt: string;
  /** Per-phase model (defaults to role-level). Same provider only —
   *  cross-provider conversation history requires translation that's
   *  out of scope. */
  model: ModelConfig;
  /** Per-phase tool whitelist (defaults to role-level). Each name
   *  must resolve in the ToolRegistry passed to runAgent. */
  tools: string[];
  /** Per-phase step budget (defaults to role-level maxSteps). */
  maxSteps: number;
}

export interface AgentRole {
  name: string;
  model: ModelConfig;
  /** Tool names looked up in the registry passed to runAgent. */
  tools: string[];
  /** Default 10. Caps the tool-use loop so a runaway agent can't churn forever. */
  maxSteps?: number;
  /** Build the system prompt and the ordered list of phases for this
   *  input. Single-phase roles return a 1-element phases array. */
  buildPhases(input: AgentInput): Promise<{ system: string; phases: AgentPhase[] }>;
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

export interface RunAgentOptions {
  /**
   * Pre-resolved language model to use instead of resolveModel(role.model).
   * Useful for tests (mock models) and for per-call routing where the
   * caller has already chosen a model based on input shape.
   */
  modelOverride?: LanguageModel;
}

// ── Public entry point ────────────────────────────────────────────

export async function runAgent(
  role: AgentRole,
  input: AgentInput,
  registry: ToolRegistry,
  options: RunAgentOptions = {},
): Promise<AgentRunResult> {
  return withPathLock(role.concurrencyKey(input), async () => {
    const idem = role.idempotencyKey(input);
    const ctx = makeContext(input.space, role.name);
    const runStartedAt = Date.now();

    if (await alreadyProcessed(role.name, idem)) {
      ctx.trace("run.skipped", {
        reason: "already_processed",
        idempotency_key: idem.key,
        input_hash: idem.hash,
        trigger_path: input.triggerPath,
      });
      return { skipped: true, reason: "already_processed", edits: [], text: "", steps: 0 };
    }

    const { system, phases } = await role.buildPhases(input);
    if (phases.length === 0) {
      throw new Error(`Role '${role.name}': buildPhases returned no phases`);
    }

    ctx.trace("run.start", {
      space_name: input.space.name,
      idempotency_key: idem.key,
      input_hash: idem.hash,
      trigger_path: input.triggerPath,
      trigger_entity_id: input.triggerEntityId,
      phases: phases.map((p) => p.name),
      system_chars: system.length,
    });

    // Each phase resolves to its own model + tools. We keep the system
    // message constant across phases (it's the role's identity) and
    // append a new user message at every phase boundary, preserving
    // conversation history. The LLM in phase N sees every tool call
    // and result from phases 1..N-1.
    let conversation: ModelMessage[] = [];
    let totalSteps = 0;
    let lastText = "";
    let aggregatedUsage: AgentRunResult["usage"] = undefined;

    try {
      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        ctx.currentPhase = phase.name;
        const phaseStartedAt = Date.now();

        // Resolve tools for this phase.
        const tools: Record<string, Tool> = {};
        for (const name of phase.tools) {
          const factory = registry[name];
          if (!factory) {
            throw new Error(
              `Phase '${phase.name}' of role '${role.name}': unknown tool '${name}'`,
            );
          }
          tools[name] = factory(ctx);
        }

        // Append this phase's prompt as a user message. modelOverride
        // (test seam) wins over per-phase model resolution.
        conversation = [
          ...conversation,
          { role: "user", content: phase.prompt },
        ];

        const model =
          options.modelOverride ?? (resolveModel(phase.model) as LanguageModel);

        ctx.trace("phase.start", {
          phase_index: i,
          model: describeModel(phase.model),
          tools: phase.tools,
          max_steps: phase.maxSteps,
          prompt_chars: phase.prompt.length,
          prompt_preview: truncateForTrace(phase.prompt, 240),
        });

        const result = await generateText({
          model,
          system,
          messages: conversation,
          tools,
          stopWhen: stepCountIs(phase.maxSteps),
        });

        // Append the assistant + tool messages from this phase so the
        // next phase sees them.
        conversation = [...conversation, ...result.response.messages];

        totalSteps += result.steps.length;
        lastText = result.text;
        aggregatedUsage = mergeUsage(aggregatedUsage, {
          inputTokens: result.totalUsage?.inputTokens,
          outputTokens: result.totalUsage?.outputTokens,
          totalTokens: result.totalUsage?.totalTokens,
        });

        ctx.trace("phase.end", {
          phase_index: i,
          steps: result.steps.length,
          finish_reason: result.finishReason,
          text_chars: result.text.length,
          text_preview: truncateForTrace(result.text, 500),
          usage: {
            input_tokens: result.totalUsage?.inputTokens,
            output_tokens: result.totalUsage?.outputTokens,
            total_tokens: result.totalUsage?.totalTokens,
          },
          duration_ms: Date.now() - phaseStartedAt,
        });
        ctx.currentPhase = null;
      }

      await markProcessed(role.name, idem, "completed", null);

      ctx.trace("run.end", {
        ok: true,
        total_steps: totalSteps,
        total_edits: ctx.edits.length,
        usage: aggregatedUsage,
        duration_ms: Date.now() - runStartedAt,
      });

      return {
        skipped: false,
        edits: ctx.edits,
        text: lastText,
        steps: totalSteps,
        usage: aggregatedUsage,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markProcessed(role.name, idem, "failed", msg);
      ctx.trace("run.error", {
        error: msg,
        total_steps: totalSteps,
        total_edits: ctx.edits.length,
        usage: aggregatedUsage,
        duration_ms: Date.now() - runStartedAt,
      });
      throw err;
    }
  });
}

function mergeUsage(
  a: AgentRunResult["usage"],
  b: AgentRunResult["usage"],
): AgentRunResult["usage"] {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  };
}

// ── Helpers ───────────────────────────────────────────────────────

export function makeContext(
  space: Space,
  role: string,
  options: { runId?: string; tracer?: Tracer } = {},
): AgentContext {
  const edits: ApplyEditResult[] = [];
  const runId = options.runId ?? randomUUID();
  const tracer = options.tracer ?? getTracer();
  const ctx: AgentContext = {
    space,
    role,
    runId,
    currentPhase: null,
    edits,
    applyEdit: async (edit, opts) => {
      const result = await applyEdit(space, edit, {
        role,
        edit_kind: opts.edit_kind,
        note: opts.note,
      });
      edits.push(result);
      // Edit event fires after the write succeeds. We deliberately log
      // path + size, never the body — the source of truth is the file.
      ctx.trace("edit", {
        path: result.path,
        edit_kind: opts.edit_kind,
        edit_mode: edit.kind, // "write" | "edit"
        note: opts.note,
        search_chars: edit.kind === "edit" ? edit.search.length : 0,
        replace_chars:
          edit.kind === "edit"
            ? edit.replace.length
            : edit.kind === "write"
              ? edit.content.length
              : 0,
      });
      return result;
    },
    log: (level, msg, meta) => {
      const tail = meta ? ` ${JSON.stringify(meta)}` : "";
      console.log(`[agent/${role}/${level}] ${msg}${tail}`);
    },
    trace: (event, fields) => {
      if (!tracer.enabled) return;
      tracer.emit({
        event,
        run_id: runId,
        role,
        space_id: space.id,
        phase: ctx.currentPhase,
        ...(fields ?? {}),
      });
    },
  };
  return ctx;
}

/** Compact representation of a model config for trace events. We don't
 *  log the API key, baseURL, or anything that could leak secrets. */
function describeModel(model: ModelConfig): string {
  return `${model.provider}:${model.id}`;
}

/**
 * Deterministic hash of an arbitrary JSON-serializable value. Used to
 * decide whether a re-trigger represents new work.
 *
 * Object keys are sorted recursively before hashing so two objects that
 * are logically equal but built in different key orders produce the
 * same digest — without this, role-defined idempotencyKey functions
 * could spuriously re-trigger when callers happen to assemble the input
 * in a different order.
 */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
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
