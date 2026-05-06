// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetTracerForTests,
  getTracer,
  truncateForTrace,
} from "../../src/server/agents/tracer.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "arkeon-tracer-"));
  _resetTracerForTests();
  delete process.env.ARKEON_WIKI_AGENT_TRACE;
  delete process.env.ARKEON_WIKI_AGENT_TRACE_FILE;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.ARKEON_WIKI_AGENT_TRACE;
  delete process.env.ARKEON_WIKI_AGENT_TRACE_FILE;
  _resetTracerForTests();
});

describe("tracer", () => {
  it("is disabled by default — emit() is a no-op and no file is created", () => {
    const tracer = getTracer();
    expect(tracer.enabled).toBe(false);

    tracer.emit({ event: "run.start", run_id: "r1" });

    // No env var, no override path: nothing should land anywhere.
    expect(existsSync(join(tmp, "agent-trace.jsonl"))).toBe(false);
  });

  it.each([
    ["0", false],
    ["false", false],
    ["FALSE", false],
    ["", false],
    ["no", false],
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
  ])("env value '%s' -> enabled=%s", (value, expected) => {
    process.env.ARKEON_WIKI_AGENT_TRACE = value;
    _resetTracerForTests();
    const tracer = getTracer();
    expect(tracer.enabled).toBe(expected);
  });

  it("writes JSONL events to ARKEON_WIKI_AGENT_TRACE_FILE when enabled", () => {
    const file = join(tmp, "trace.jsonl");
    process.env.ARKEON_WIKI_AGENT_TRACE = "1";
    process.env.ARKEON_WIKI_AGENT_TRACE_FILE = file;
    _resetTracerForTests();

    const tracer = getTracer();
    tracer.emit({ event: "run.start", run_id: "r1", role: "ingestor" });
    tracer.emit({ event: "tool.call", run_id: "r1", tool: "search" });
    tracer.emit({ event: "run.end", run_id: "r1", ok: true });

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].event).toBe("run.start");
    expect(parsed[0].run_id).toBe("r1");
    expect(parsed[0].role).toBe("ingestor");
    expect(parsed[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed[1].tool).toBe("search");
    expect(parsed[2].event).toBe("run.end");
  });

  it("creates the parent directory lazily on first emit", () => {
    const file = join(tmp, "nested", "deeply", "trace.jsonl");
    process.env.ARKEON_WIKI_AGENT_TRACE = "1";
    process.env.ARKEON_WIKI_AGENT_TRACE_FILE = file;
    _resetTracerForTests();

    const tracer = getTracer();
    expect(existsSync(file)).toBe(false);

    tracer.emit({ event: "run.start" });
    expect(existsSync(file)).toBe(true);
  });
});

describe("truncateForTrace", () => {
  it("returns short values unchanged", () => {
    expect(truncateForTrace("hello")).toBe("hello");
    expect(truncateForTrace({ x: 1 })).toEqual({ x: 1 });
    expect(truncateForTrace(42)).toBe(42);
  });

  it("truncates long strings and reports the full length", () => {
    const long = "a".repeat(2000);
    const out = truncateForTrace(long, 100) as {
      value: string;
      truncated: boolean;
      full_chars: number;
    };
    expect(out.truncated).toBe(true);
    expect(out.full_chars).toBe(2000);
    expect(out.value.length).toBe(100);
  });

  it("truncates long objects via JSON serialization", () => {
    const big = { items: Array.from({ length: 200 }, (_, i) => `item-${i}`) };
    const out = truncateForTrace(big, 80) as {
      value: string;
      truncated: boolean;
      full_chars: number;
    };
    expect(out.truncated).toBe(true);
    expect(out.value.length).toBe(80);
    expect(out.full_chars).toBeGreaterThan(80);
  });
});
