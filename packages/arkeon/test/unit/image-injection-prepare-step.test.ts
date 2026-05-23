// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the image-injection prepareStep wrapper.
 *
 * Tests the contract: given a populated ctx.imageQueue and a step
 * result naming toolCallIds, the wrapper should return overridden
 * messages with the assistant bridge + user(text + image parts)
 * appended. Out-of-band cases (empty queue, no prior steps, tool
 * call IDs that don't match any queue entry) must return undefined
 * so generateText falls through to its default behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeContext,
  makeImageInjectionPrepareStep,
  type AgentContext,
} from "../../src/server/agents/runtime.js";
import type { ModelMessage } from "ai";

const SPACE = { name: "inj-test", watch_dir: "/tmp" };

let ctx: AgentContext;

beforeEach(() => {
  ctx = makeContext(SPACE, "test-role");
});

afterEach(() => {
  ctx.imageQueue.clear();
});

// Fake step shape — only the fields the wrapper actually reads.
function fakeStep(toolCallIds: string[]) {
  return { toolCalls: toolCallIds.map((id) => ({ toolCallId: id })) };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("image-injection prepareStep wrapper", () => {
  it("returns undefined when no steps have run yet", () => {
    const prep = makeImageInjectionPrepareStep(ctx);
    expect(prep({ steps: [], messages: [] })).toBeUndefined();
  });

  it("returns undefined when the last step had no tool calls", () => {
    const prep = makeImageInjectionPrepareStep(ctx);
    expect(prep({ steps: [fakeStep([])], messages: [] })).toBeUndefined();
  });

  it("returns undefined when tool calls don't match any queued images", () => {
    ctx.imageQueue.set("OTHER", [
      { source: "x.png", mediaType: "image/png", data: PNG },
    ]);
    const prep = makeImageInjectionPrepareStep(ctx);
    expect(
      prep({ steps: [fakeStep(["UNMATCHED"])], messages: [] }),
    ).toBeUndefined();
  });

  it("splices assistant bridge + user(text + image) when queue has bytes for the tool call", () => {
    ctx.imageQueue.set("CALL1", [
      { source: "chart.png", mediaType: "image/png", data: PNG },
    ]);
    const existing: ModelMessage[] = [
      { role: "user", content: "fetch the chart" },
    ];
    const prep = makeImageInjectionPrepareStep(ctx);
    const result = prep({
      steps: [fakeStep(["CALL1"])],
      messages: existing,
    });

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(existing.length + 2);

    const bridge = result!.messages[existing.length];
    expect(bridge.role).toBe("assistant");
    expect(bridge.content).toBe("Reviewing the fetched content.");

    const userMsg = result!.messages[existing.length + 1];
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{
      type: string;
      text?: string;
      image?: Buffer;
      mediaType?: string;
    }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("chart.png");
    expect(parts[1].type).toBe("image");
    expect(parts[1].image!.equals(PNG)).toBe(true);
    expect(parts[1].mediaType).toBe("image/png");
  });

  it("bundles multiple images from a single tool call into one user message", () => {
    ctx.imageQueue.set("BATCH", [
      { source: "a.png", mediaType: "image/png", data: PNG },
      { source: "b.jpg", mediaType: "image/jpeg", data: Buffer.from([0xff]) },
    ]);
    const prep = makeImageInjectionPrepareStep(ctx);
    const result = prep({ steps: [fakeStep(["BATCH"])], messages: [] });
    const parts = (result!.messages[1].content as Array<{ type: string }>);
    // 2 images × (text + image) = 4 parts
    expect(parts).toHaveLength(4);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(2);
  });

  it("bundles parallel tool calls into one user message", () => {
    ctx.imageQueue.set("CALL_A", [
      { source: "a.png", mediaType: "image/png", data: PNG },
    ]);
    ctx.imageQueue.set("CALL_B", [
      { source: "b.png", mediaType: "image/png", data: PNG },
    ]);
    const prep = makeImageInjectionPrepareStep(ctx);
    const result = prep({
      steps: [fakeStep(["CALL_A", "CALL_B"])],
      messages: [],
    });
    const parts = result!.messages[1].content as Array<{ type: string }>;
    expect(parts.filter((p) => p.type === "image")).toHaveLength(2);
  });

  it("drains the queue after splicing (idempotent: second invocation with same tool calls is no-op)", () => {
    ctx.imageQueue.set("CALL1", [
      { source: "x.png", mediaType: "image/png", data: PNG },
    ]);
    const prep = makeImageInjectionPrepareStep(ctx);
    const first = prep({ steps: [fakeStep(["CALL1"])], messages: [] });
    expect(first).toBeDefined();
    const second = prep({ steps: [fakeStep(["CALL1"])], messages: [] });
    expect(second).toBeUndefined();
    expect(ctx.imageQueue.has("CALL1")).toBe(false);
  });

  it("preserves the existing message history before the splice", () => {
    ctx.imageQueue.set("CALL1", [
      { source: "x.png", mediaType: "image/png", data: PNG },
    ]);
    const existing: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ];
    const prep = makeImageInjectionPrepareStep(ctx);
    const result = prep({
      steps: [fakeStep(["CALL1"])],
      messages: existing,
    });
    expect(result!.messages.slice(0, 3)).toEqual(existing);
  });
});
