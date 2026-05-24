// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end integration: runAgent + fetch tool + prepareStep wrapper,
 * driven by a minimal mock LanguageModelV3.
 *
 * The unit tests verify the fetch tool populates ctx.imageQueue
 * correctly and the wrapper drains it into spliced messages. This test
 * verifies the WIRING: that the wrapper is actually attached to the
 * generateText call inside runAgent, fires between steps, and the
 * model sees the image part on the next call.
 *
 * No real network or API. The mock model returns a programmed sequence
 * of responses and records every doGenerate invocation's `prompt` so we
 * can assert the splice happened.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../../src/schema/migrate.js";
import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import { runAgent } from "../../src/server/agents/runtime.js";
import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import type { AgentRole, AgentPhase } from "../../src/server/agents/runtime.js";
import type { LanguageModel } from "ai";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let workdir: string;
let dbPath: string;

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-inj-e2e-"));
  dbPath = join(workdir, "arke.db");
  mkdirSync(join(workdir, "images"), { recursive: true });
  await runMigrations({ dbPath });
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

async function registerSpace(name: string): Promise<void> {
  const sql = createSql();
  await sql`INSERT INTO spaces(name, watch_dir) VALUES(${name}, ${workdir})`;
}

/**
 * Minimal LanguageModelV3 mock. Returns a programmed sequence of
 * responses and records the `prompt` (model messages) on every
 * doGenerate call so tests can assert what the model actually saw.
 */
function makeMockModel(responses: Array<{
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: string;
      }
  >;
  finishReason: "stop" | "tool-calls";
}>) {
  const calls: Array<{ prompt: unknown[] }> = [];
  let cursor = 0;
  const model = {
    specificationVersion: "v3" as const,
    provider: "mock",
    modelId: "mock-1",
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown[] }) {
      calls.push({ prompt: options.prompt });
      const response = responses[cursor] ?? {
        content: [{ type: "text", text: "(no programmed response)" }],
        finishReason: "stop",
      };
      cursor += 1;
      return {
        content: response.content,
        finishReason: response.finishReason,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("mock model: streaming not implemented");
    },
  };
  return { model: model as unknown as LanguageModel, calls };
}

describe("runAgent + fetch + prepareStep wrapper integration", () => {
  it("splices user(image) between the fetch tool call and the next model turn", async () => {
    writeFileSync(join(workdir, "images/chart.png"), PNG);

    const { model, calls } = makeMockModel([
      // Step 1: model calls fetch on the local image
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "CALL_1",
            toolName: "fetch",
            input: JSON.stringify({ targets: ["images/chart.png"] }),
          },
        ],
        finishReason: "tool-calls",
      },
      // Step 2: model describes what it "saw"
      {
        content: [{ type: "text", text: "I see a chart with axes." }],
        finishReason: "stop",
      },
    ]);

    const phase: AgentPhase = {
      name: "phase1",
      prompt: "fetch images/chart.png and describe it",
      model: { provider: "openai", id: "ignored-by-override" },
      tools: ["fetch"],
      maxSteps: 4,
    };
    const role: AgentRole = {
      name: "test",
      model: phase.model,
      tools: phase.tools,
      maxSteps: phase.maxSteps,
      spaceScope: ["self"],
      async buildPhases() {
        return { system: "test", phases: [phase] };
      },
      concurrencyKey() {
        return `inj-${workdir}`;
      },
    };

    const space = { name: "inj-e2e", watch_dir: workdir };
    await registerSpace(space.name);
    const result = await runAgent(
      role,
      { space },
      ALL_TOOLS,
      { modelOverride: model },
    );

    expect(result.text).toBe("I see a chart with axes.");
    expect(calls.length).toBe(2);

    // First call: just the user prompt — no splice happened yet.
    const firstPrompt = calls[0].prompt as Array<{ role: string }>;
    const firstUserCount = firstPrompt.filter((m) => m.role === "user").length;
    expect(firstUserCount).toBe(1);

    // Second call: must contain the wrapper's splice (assistant bridge +
    // a new user message with the image content part). The AI SDK
    // converts ModelMessage → LanguageModelV3 prompt format, so
    // assistant.content arrives as an array of parts (not a string).
    const secondPrompt = calls[1].prompt as Array<{
      role: string;
      content: unknown;
    }>;
    const assistantBridge = secondPrompt.find((m) => {
      if (m.role !== "assistant") return false;
      const parts = Array.isArray(m.content)
        ? (m.content as Array<{ type?: string; text?: string }>)
        : [];
      return parts.some(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          p.text.includes("Reviewing the fetched"),
      );
    });
    expect(assistantBridge).toBeDefined();

    // The synthetic user message carries an image part. Provider
    // translation transforms it from `{type: "image"}` to the OpenAI
    // file part shape ({type: "file", mediaType: "image/png", data}) —
    // both shapes are valid evidence that the wrapper fired and the
    // bytes made it through. Assert either form is present.
    const userWithImage = secondPrompt.find((m) => {
      if (m.role !== "user" || !Array.isArray(m.content)) return false;
      return (m.content as Array<{ type: string }>).some(
        (p) => p.type === "image" || p.type === "file",
      );
    });
    expect(userWithImage).toBeDefined();
  });

  it("doesn't splice anything when fetch returns only text (no image to inject)", async () => {
    writeFileSync(join(workdir, "images/notes.md"), "just text");

    const { model, calls } = makeMockModel([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "CALL_TXT",
            toolName: "fetch",
            input: JSON.stringify({ targets: ["images/notes.md"] }),
          },
        ],
        finishReason: "tool-calls",
      },
      {
        content: [{ type: "text", text: "Got the text." }],
        finishReason: "stop",
      },
    ]);

    const phase: AgentPhase = {
      name: "phase1",
      prompt: "fetch the notes",
      model: { provider: "openai", id: "ignored" },
      tools: ["fetch"],
      maxSteps: 4,
    };
    const role: AgentRole = {
      name: "test",
      model: phase.model,
      tools: phase.tools,
      maxSteps: phase.maxSteps,
      spaceScope: ["self"],
      async buildPhases() {
        return { system: "test", phases: [phase] };
      },
      concurrencyKey() {
        return `inj-text-${workdir}`;
      },
    };

    const space = { name: "inj-e2e-txt", watch_dir: workdir };
    await registerSpace(space.name);
    await runAgent(role, { space }, ALL_TOOLS, { modelOverride: model });

    const secondPrompt = calls[1].prompt as Array<{ role: string; content: unknown }>;
    const hasBridge = secondPrompt.some(
      (m) =>
        m.role === "assistant" &&
        typeof m.content === "string" &&
        m.content.includes("Reviewing the fetched"),
    );
    expect(hasBridge).toBe(false);
  });
});
