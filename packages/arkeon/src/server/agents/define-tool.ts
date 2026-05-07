// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defineTool` — the boilerplate-eating helper that turns a regular
 * library function into an AI-SDK-compatible tool factory.
 *
 * Each tool defined with this helper:
 *   - has its description and input schema in one place
 *   - auto-binds the AgentContext (so `space` is wired without effort)
 *   - logs every invocation through ctx.log
 *   - is reused across roles by name (see ./tools.ts)
 *
 * Adding a new tool is one entry in tools.ts; the bottlenecks
 * (description quality, schema design) are forced into the open.
 */

import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "./runtime.js";
import { truncateForTrace } from "./tracer.js";

export interface DefineToolOptions<TInput, TOutput> {
  description: string;
  inputSchema: z.ZodType<TInput>;
  /** What actually runs. Receives the validated input and the agent
   *  context (space, applyEdit, log, ...). */
  call: (input: TInput, ctx: AgentContext) => Promise<TOutput> | TOutput;
  /** Optional small summary of the tool's result for trace events.
   *  Tools whose results can be large (search, list_entities, read_file)
   *  should supply this so traces stay legible. If omitted, the tracer
   *  records the byte size of the full result instead. */
  summarize?: (result: TOutput) => unknown;
}

/** A function that, given a context, returns the AI-SDK tool. */
export type ToolFactory = (ctx: AgentContext) => Tool;

export function defineTool<TInput, TOutput>(
  name: string,
  opts: DefineToolOptions<TInput, TOutput>,
): ToolFactory {
  return (ctx: AgentContext): Tool => {
    const definition = {
      description: opts.description,
      inputSchema: opts.inputSchema,
      execute: async (input: TInput) => {
        ctx.log("info", `tool/${name}`, { input });
        ctx.trace("tool.call", {
          tool: name,
          args: truncateForTrace(input),
        });
        const startedAt = Date.now();
        try {
          const result = await opts.call(input, ctx);
          ctx.trace("tool.result", {
            tool: name,
            ok: true,
            duration_ms: Date.now() - startedAt,
            summary: opts.summarize
              ? opts.summarize(result)
              : { result_chars: estimateChars(result) },
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.log("error", `tool/${name} failed`, { error: message });
          ctx.trace("tool.result", {
            tool: name,
            ok: false,
            duration_ms: Date.now() - startedAt,
            error: message,
          });
          throw err;
        }
      },
    };
    // The AI SDK's Tool type carries a tangle of provider-specific
    // generics (FlexibleSchema, ToolOutputProperties, ...) that don't
    // infer cleanly from our user-facing DefineToolOptions shape. The
    // double cast skips that inference dance — the runtime contract
    // (description + inputSchema + execute) is what the SDK actually
    // calls, and that's what `definition` provides.
    return definition as unknown as Tool;
  };
}

function estimateChars(value: unknown): number {
  if (value == null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}
