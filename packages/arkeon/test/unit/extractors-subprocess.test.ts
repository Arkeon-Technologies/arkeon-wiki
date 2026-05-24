// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  runSubprocess,
  SubprocessError,
  _semaphoreForTest,
} from "../../src/server/extractors/subprocess.js";

// Use the node binary itself as a portable subprocess. -e takes a JS
// expression so we don't need to ship test fixture scripts.
const NODE = process.execPath;

describe("runSubprocess", () => {
  it("captures stdout from a successful run", async () => {
    const { stdout, stderr } = await runSubprocess({
      cmd: NODE,
      args: ["-e", `process.stdout.write("hello world")`],
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(stdout).toBe("hello world");
    expect(stderr).toBe("");
  });

  it("captures stderr alongside stdout", async () => {
    const { stdout, stderr } = await runSubprocess({
      cmd: NODE,
      args: [
        "-e",
        `process.stdout.write("OUT");process.stderr.write("ERR")`,
      ],
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(stdout).toBe("OUT");
    expect(stderr).toBe("ERR");
  });

  it("throws SubprocessError on non-zero exit, surfacing stderr", async () => {
    await expect(
      runSubprocess({
        cmd: NODE,
        args: [
          "-e",
          `process.stderr.write("boom");process.exit(7)`,
        ],
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      name: "SubprocessError",
      code: 7,
      stderr: "boom",
    });
  });

  it("kills the subprocess on timeout", async () => {
    const start = Date.now();
    const err: unknown = await runSubprocess({
      cmd: NODE,
      args: ["-e", `setTimeout(() => process.exit(0), 60_000)`],
      signal: new AbortController().signal,
      timeoutMs: 200,
    }).catch((e) => e);
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(SubprocessError);
    expect((err as SubprocessError).message).toMatch(/timed out/i);
    // Sanity check that the timer actually fired — not the 60s sleep.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("respects an external AbortSignal", async () => {
    const controller = new AbortController();
    const promise = runSubprocess({
      cmd: NODE,
      args: ["-e", `setTimeout(() => process.exit(0), 60_000)`],
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    // Cancel almost immediately.
    setTimeout(() => controller.abort(), 50);
    const err: unknown = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(SubprocessError);
    expect((err as SubprocessError).message).toMatch(/abort/i);
  });

  it("rejects when stdout exceeds maxStdoutBytes", async () => {
    const err: unknown = await runSubprocess({
      cmd: NODE,
      args: [
        "-e",
        // Write 2KB chunks until killed.
        `const buf="x".repeat(2048);setInterval(()=>process.stdout.write(buf),5)`,
      ],
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      maxStdoutBytes: 8 * 1024, // 8KB cap
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SubprocessError);
    expect((err as SubprocessError).message).toMatch(/stdout exceeded/i);
  });
});

describe("global concurrency semaphore", () => {
  it("exposes a numeric cap >= 1", () => {
    expect(_semaphoreForTest.cap).toBeGreaterThanOrEqual(1);
  });

  it("serializes work beyond the cap", async () => {
    // Spawn cap+2 subprocesses that each report their actual start time
    // (printed from inside the subprocess, not measured before acquire)
    // so we measure running concurrency, not call-time concurrency.
    const cap = _semaphoreForTest.cap;
    const N = cap + 2;
    const intervals: Array<[number, number]> = [];
    await Promise.all(
      Array.from({ length: N }, async () => {
        const { stdout } = await runSubprocess({
          cmd: NODE,
          args: [
            "-e",
            `process.stdout.write(String(Date.now()));setTimeout(()=>{process.stdout.write("|" + String(Date.now()));process.exit(0)}, 200)`,
          ],
          signal: new AbortController().signal,
          timeoutMs: 5_000,
        });
        const [s, e] = stdout.split("|").map((n) => Number(n));
        intervals.push([s!, e!]);
      }),
    );

    let maxOverlap = 0;
    for (let i = 0; i < intervals.length; i++) {
      let overlap = 0;
      for (let j = 0; j < intervals.length; j++) {
        if (i === j) continue;
        const [aStart, aEnd] = intervals[i]!;
        const [bStart, bEnd] = intervals[j]!;
        if (aStart < bEnd && bStart < aEnd) overlap += 1;
      }
      maxOverlap = Math.max(maxOverlap, overlap);
    }
    // maxOverlap counts the *other* tasks that overlapped with task i,
    // so total concurrent is maxOverlap + 1.
    expect(maxOverlap + 1).toBeLessThanOrEqual(cap);
  });
});
