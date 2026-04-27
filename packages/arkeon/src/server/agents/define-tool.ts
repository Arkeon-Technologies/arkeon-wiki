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

export interface DefineToolOptions<TInput, TOutput> {
  description: string;
  inputSchema: z.ZodType<TInput>;
  /** Mutating tools must be opted into — useful when (later) gating
   *  read-only review modes. Defaults to false (mutating). */
  readOnly?: boolean;
  /** What actually runs. Receives the validated input and the agent
   *  context (space, applyEdit, log, ...). */
  call: (input: TInput, ctx: AgentContext) => Promise<TOutput> | TOutput;
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
        try {
          return await opts.call(input, ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.log("error", `tool/${name} failed`, { error: message });
          throw err;
        }
      },
    };
    return definition as unknown as Tool;
  };
}
