// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { defineTool } from "../../src/server/agents/define-tool.js";
import { resolveModel } from "../../src/server/agents/model.js";
import type { AgentContext } from "../../src/server/agents/runtime.js";

function makeFakeContext(): AgentContext {
  return {
    space: { id: "test-space", name: "test", watch_dir: "/tmp/nope" },
    role: "test-role",
    runId: "test-run-id",
    currentPhase: null,
    edits: [],
    applyEdit: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    log: vi.fn(),
    trace: vi.fn(),
  };
}

describe("defineTool", () => {
  it("validates input via Zod and forwards to call()", async () => {
    const fn = vi.fn(async (input: { x: number }) => ({ doubled: input.x * 2 }));
    const factory = defineTool("double", {
      description: "Double a number.",
      inputSchema: z.object({ x: z.number() }),
      call: fn,
    });

    const ctx = makeFakeContext();
    const t = factory(ctx) as { execute: (input: unknown) => Promise<unknown> };
    const result = await t.execute({ x: 21 });

    expect(result).toEqual({ doubled: 42 });
    expect(fn).toHaveBeenCalledWith({ x: 21 }, ctx);
  });

  it("logs invocations through ctx.log", async () => {
    const factory = defineTool("noop", {
      description: "no-op",
      inputSchema: z.object({}),
      call: () => ({ ok: true }),
    });
    const ctx = makeFakeContext();
    const t = factory(ctx) as { execute: (input: unknown) => Promise<unknown> };
    await t.execute({});
    expect(ctx.log).toHaveBeenCalledWith("info", "tool/noop", { input: {} });
  });

  it("rethrows after logging failures", async () => {
    const factory = defineTool("boom", {
      description: "always throws",
      inputSchema: z.object({}),
      call: () => {
        throw new Error("kaboom");
      },
    });
    const ctx = makeFakeContext();
    const t = factory(ctx) as { execute: (input: unknown) => Promise<unknown> };

    await expect(t.execute({})).rejects.toThrow("kaboom");
    expect(ctx.log).toHaveBeenCalledWith(
      "error",
      "tool/boom failed",
      { error: "kaboom" },
    );
  });

  it("emits tool.call and tool.result trace events on success", async () => {
    const factory = defineTool("traced", {
      description: "trace me",
      inputSchema: z.object({ q: z.string() }),
      call: () => ({ hits: [1, 2, 3] }),
      summarize: (r) => ({ count: r.hits.length }),
    });
    const ctx = makeFakeContext();
    const t = factory(ctx) as { execute: (input: unknown) => Promise<unknown> };
    await t.execute({ q: "holmes" });

    expect(ctx.trace).toHaveBeenCalledWith("tool.call", {
      tool: "traced",
      args: { q: "holmes" },
    });
    const calls = (ctx.trace as ReturnType<typeof vi.fn>).mock.calls;
    const resultCall = calls.find((c) => c[0] === "tool.result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({
      tool: "traced",
      ok: true,
      summary: { count: 3 },
    });
    // duration_ms is non-deterministic but must be present and a number.
    expect(typeof resultCall![1].duration_ms).toBe("number");
  });

  it("emits tool.result with ok:false when the tool throws", async () => {
    const factory = defineTool("explodes", {
      description: "explodes",
      inputSchema: z.object({}),
      call: () => {
        throw new Error("nope");
      },
    });
    const ctx = makeFakeContext();
    const t = factory(ctx) as { execute: (input: unknown) => Promise<unknown> };
    await expect(t.execute({})).rejects.toThrow("nope");

    const calls = (ctx.trace as ReturnType<typeof vi.fn>).mock.calls;
    const resultCall = calls.find((c) => c[0] === "tool.result");
    expect(resultCall![1]).toMatchObject({
      tool: "explodes",
      ok: false,
      error: "nope",
    });
  });

  it("falls back to result_chars summary when summarize is omitted", async () => {
    const factory = defineTool("unsummarized", {
      description: "no summarize fn",
      inputSchema: z.object({}),
      call: () => ({ a: 1, b: 2 }),
    });
    const ctx = makeFakeContext();
    const t = factory(ctx) as { execute: (input: unknown) => Promise<unknown> };
    await t.execute({});

    const calls = (ctx.trace as ReturnType<typeof vi.fn>).mock.calls;
    const resultCall = calls.find((c) => c[0] === "tool.result");
    expect(resultCall![1].summary).toEqual({
      result_chars: JSON.stringify({ a: 1, b: 2 }).length,
    });
  });
});

describe("resolveModel", () => {
  it("returns a model for the anthropic provider", () => {
    const model = resolveModel({
      provider: "anthropic",
      id: "claude-opus-4-7",
      apiKey: "sk-ant-test",
    });
    expect(model).toBeDefined();
    // provider field reflects the underlying SDK's identifier for telemetry
    expect((model as { provider?: string }).provider).toMatch(/anthropic/i);
  });

  it("returns a model for the openai provider", () => {
    const model = resolveModel({
      provider: "openai",
      id: "gpt-5",
      apiKey: "sk-test",
    });
    expect(model).toBeDefined();
    expect((model as { provider?: string }).provider).toMatch(/openai/i);
  });

  it("returns a model for openai-compatible (e.g. Ollama, OpenRouter)", () => {
    const model = resolveModel({
      provider: "openai-compatible",
      id: "llama3.1:70b",
      baseURL: "http://localhost:11434/v1",
    });
    expect(model).toBeDefined();
  });
});

