// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent runtime: the shared loop that powers the writer and any
 * future role.
 *
 * A role describes:
 *   - which model to call          (ModelConfig)
 *   - what prompt to send          (buildPhases)
 *   - what tools the LLM can use   (a list of names from the registry)
 *   - how to key concurrency       (so two runs targeting the same
 *                                    wiki/source serialize)
 *
 * The runtime owns: locking, tool wiring, the AI SDK call, the per-run
 * read-gate (`readPaths`). Roles stay tiny.
 */

import { randomUUID } from "node:crypto";

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
import { type Space } from "../lib/sync.js";

import type { ReasoningEffort } from "./config.js";
import { resolveModel, type ModelConfig } from "./model.js";
import { resolveAllowedSpaces } from "./space-scope.js";
import { getTracer, truncateForTrace, type Tracer } from "./tracer.js";

// ── Types ─────────────────────────────────────────────────────────

export interface ToolEditOpts {
  edit_kind: EditKind;
  note?: string;
}

/**
 * A single image queued by an image-bearing tool (e.g. `fetch`), waiting
 * to be spliced into the next step's messages by the runtime's
 * prepareStep wrapper. `mediaType` is the canonical content-type the
 * AI SDK expects; `data` is the raw bytes.
 */
export interface QueuedImage {
  /** Display string in the bridge text — e.g. the URL or local path. */
  source: string;
  mediaType: string;
  data: Buffer;
}

export interface AgentContext {
  space: Space;
  allowedSpaces: Space[];
  role: string;
  runId: string;
  currentPhase: string | null;
  edits: ApplyEditResult[];
  /**
   * Per-run set of paths the agent has called `read_file` on.
   *
   * Load-bearing reliability property: `edit_file` refuses to mutate
   * a path that's not in this set. `create_file` and `delete_wiki`
   * are terminal and don't interact with the gate.
   *
   * Successful edits invalidate the path (the runtime removes it from
   * the set) so the model is forced to re-read before its next edit.
   * Empirically dropped the "edit from stale memory" error class to
   * zero across the bake-off in tasks/v0-agent-harness-edit-primitives.md.
   *
   * Keyed by `${space.name}::${path}` so multi-space roles don't have
   * a read in one space silently authorize an edit in another (edits
   * still always target ctx.space, but the indirection is cheap and
   * makes the invariant obvious).
   */
  readPaths: Set<string>;
  /**
   * Per-toolCallId queue of images the tool fetched, waiting for the
   * runtime's `prepareStep` wrapper to splice them into the next step's
   * conversation as a synthetic user message.
   *
   * The wrapper exists because OpenAI / Gemini / open-source vision
   * models don't accept images in `tool`-role messages (only Anthropic
   * does, and only when using the native provider — not via OpenAI-compat
   * gateways). The portable pattern is: tool returns a textual stub,
   * runtime splices `assistant("Reviewing the fetched content.")` (the
   * "bridge" — required by Mistral-style chat templates that reject a
   * user message directly after a tool result) + `user([text, image, …])`
   * containing the actual image bytes before the next `generateText`
   * step. Validated 15/18 across Anthropic / OpenAI direct / Gemini /
   * Qwen / Mistral / Llama 3.2 Vision in pre-PR experiments.
   *
   * Tools push by calling `ctx.imageQueue.set(toolCallId, [...])`;
   * a single tool call may queue multiple images (e.g. a batched
   * `fetch(targets=[url1, url2, url3])` puts all three under one
   * toolCallId, and they all get attached to one synthetic user
   * message). `prepareStep` drains entries matching the previous
   * step's tool calls — entries for tool calls in earlier steps stay
   * around only until those steps are done (which is "immediately
   * next step" in practice; the queue is per-run so it can never
   * leak across runAgent invocations).
   */
  imageQueue: Map<string, QueuedImage[]>;
  applyEdit(edit: FileEdit, opts: ToolEditOpts): Promise<ApplyEditResult>;
  log(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void;
  trace(event: string, fields?: Record<string, unknown>): void;
}

export type ToolFactory = (ctx: AgentContext) => Tool;
export type ToolRegistry = Record<string, ToolFactory>;

export interface AgentInput {
  space: Space;
  triggerPath?: string;
  meta?: Record<string, unknown>;
}

export interface AgentPhase {
  name: string;
  prompt: string;
  model: ModelConfig;
  tools: string[];
  maxSteps: number;
  /** OpenAI reasoning_effort for this phase. Threaded through
   *  providerOptions.openai.reasoningEffort at generateText time.
   *  Ignored for non-openai providers. */
  reasoningEffort?: ReasoningEffort;
}

export interface AgentRole {
  name: string;
  model: ModelConfig;
  tools: string[];
  maxSteps?: number;
  spaceScope: string[];
  buildPhases(input: AgentInput): Promise<{ system: string; phases: AgentPhase[] }>;
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
    const allowedSpaces = await resolveAllowedSpaces(role.spaceScope, input.space);
    const ctx = makeContext(input.space, role.name, { allowedSpaces });
    const runStartedAt = Date.now();

    const { system: rawSystem, phases } = await role.buildPhases(input);
    if (phases.length === 0) {
      throw new Error(`Role '${role.name}': buildPhases returned no phases`);
    }

    const system =
      allowedSpaces.length > 1
        ? `${rawSystem}\n\n--- Allowed spaces (read-only across) ---\n` +
          `read_file requires an explicit \`space\` argument on this role. ` +
          `search and list_entities default to fanning out across every space below; ` +
          `pass \`space\` to scope to one. Edits target the triggering space only.\n\n` +
          allowedSpaces
            .map((s, i) =>
              `${i + 1}. ${s.name}${s.name === input.space.name ? " — triggering space (writes go here)" : ""}`,
            )
            .join("\n")
        : rawSystem;

    ctx.trace("run.start", {
      space_name: input.space.name,
      trigger_path: input.triggerPath,
      phases: phases.map((p) => p.name),
      system_chars: system.length,
      allowed_spaces: allowedSpaces.map((s) => s.name),
    });

    let conversation: ModelMessage[] = [];
    let totalSteps = 0;
    let lastText = "";
    let aggregatedUsage: AgentRunResult["usage"] = undefined;

    try {
      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        ctx.currentPhase = phase.name;
        const phaseStartedAt = Date.now();

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

        // reasoning_effort is OpenAI-only at the moment. For other
        // providers we silently omit it — if/when Anthropic's
        // `thinking` budget gets first-class config, it lives under
        // providerOptions.anthropic and the role config will gain its
        // own field for it.
        const providerOptions =
          phase.reasoningEffort && phase.model.provider === "openai"
            ? { openai: { reasoningEffort: phase.reasoningEffort } }
            : undefined;

        const result = await generateText({
          model,
          system,
          messages: conversation,
          tools,
          stopWhen: stepCountIs(phase.maxSteps),
          prepareStep: makeImageInjectionPrepareStep(ctx),
          ...(providerOptions ? { providerOptions } : {}),
        });

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

export function makeContext(
  space: Space,
  role: string,
  options: { runId?: string; tracer?: Tracer; allowedSpaces?: Space[] } = {},
): AgentContext {
  const edits: ApplyEditResult[] = [];
  const runId = options.runId ?? randomUUID();
  const tracer = options.tracer ?? getTracer();
  const allowedSpaces = options.allowedSpaces ?? [space];
  const readPaths = new Set<string>();
  const imageQueue = new Map<string, QueuedImage[]>();
  const ctx: AgentContext = {
    space,
    allowedSpaces,
    role,
    runId,
    currentPhase: null,
    edits,
    readPaths,
    imageQueue,
    applyEdit: async (edit, opts) => {
      const result = await applyEdit(space, edit, {
        role,
        edit_kind: opts.edit_kind,
        note: opts.note,
      });
      edits.push(result);
      // Invalidate the read-gate for this path on any successful edit
      // that wasn't a create/delete. The line-number-shift case is the
      // motivating one, but str_replace also shifts bytes; both demand
      // a re-read before the next edit.
      if (result.kind === "insert_at_line" || result.kind === "str_replace") {
        readPaths.delete(readGateKey(space.name, edit.path));
      }
      ctx.trace("edit", {
        path: result.path,
        edit_kind: opts.edit_kind,
        edit_mode: edit.kind,
        note: opts.note,
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
        space_name: space.name,
        phase: ctx.currentPhase,
        ...(fields ?? {}),
      });
    },
  };
  return ctx;
}

/**
 * Canonical key for the read-gate. Tools use this to put/check paths
 * in `ctx.readPaths` so a read in space A doesn't authorize an edit
 * in space B (writes always target ctx.space anyway, but the explicit
 * key makes the invariant obvious).
 */
export function readGateKey(spaceName: string, path: string): string {
  return `${spaceName}::${path}`;
}

function describeModel(model: ModelConfig): string {
  return `${model.provider}:${model.id}`;
}

/**
 * Build a `prepareStep` callback that drains `ctx.imageQueue` after each
 * step and splices the fetched images into the next step's conversation
 * as a synthetic user message.
 *
 * Shape of the splice, for each step where the prior step's tool calls
 * queued images:
 *
 *   ...messages (the conversation so far, including the tool result),
 *   { role: "assistant", content: "Reviewing the fetched content." },
 *   { role: "user", content: [
 *       { type: "text",  text: "[Image from fetch(<source>):]" },
 *       { type: "image", image: <bytes>, mediaType: "image/png" },
 *       ...more (text, image) pairs per queued image...
 *   ] }
 *
 * The `assistant` bridge is required by Mistral-style chat templates
 * that reject a `user` message directly after a `tool` message. It's
 * harmless on Anthropic / OpenAI / Gemini (treated as a brief filler
 * turn) — validated 15/18 in pre-PR experiments across every major
 * vision model family.
 *
 * No-op when the previous step's tool calls didn't queue any images,
 * or when there's no previous step (first step of the phase).
 */
export function makeImageInjectionPrepareStep(
  ctx: AgentContext,
): (options: {
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolCallId: string }> }>;
  messages: ModelMessage[];
}) => { messages: ModelMessage[] } | undefined {
  return ({ steps, messages }) => {
    if (steps.length === 0) return undefined;
    const lastStep = steps[steps.length - 1];
    if (!lastStep || lastStep.toolCalls.length === 0) return undefined;

    interface ImagePart {
      type: "image";
      image: Buffer;
      mediaType: string;
    }
    interface TextPart {
      type: "text";
      text: string;
    }
    const injections: Array<TextPart | ImagePart> = [];
    for (const call of lastStep.toolCalls) {
      const queued = ctx.imageQueue.get(call.toolCallId);
      if (!queued || queued.length === 0) continue;
      for (const img of queued) {
        injections.push({
          type: "text",
          text: `[Image from fetch(${img.source}) — you can see this:]`,
        });
        injections.push({
          type: "image",
          image: img.data,
          mediaType: img.mediaType,
        });
      }
      ctx.imageQueue.delete(call.toolCallId);
    }
    if (injections.length === 0) return undefined;

    ctx.trace("image_injection", {
      images: injections.filter((p): p is ImagePart => p.type === "image")
        .length,
    });

    return {
      messages: [
        ...messages,
        {
          role: "assistant",
          content: "Reviewing the fetched content.",
        },
        { role: "user", content: injections },
      ],
    };
  };
}
