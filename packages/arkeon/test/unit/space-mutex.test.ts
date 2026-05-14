// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  SpaceBusyError,
  inFlightRole,
  queueSpaceMutex,
  resetSpaceMutexForTests,
  withSpaceMutex,
} from "../../src/server/agents/space-mutex.js";

describe("space-mutex", () => {
  afterEach(() => {
    resetSpaceMutexForTests();
  });

  it("runs the function and returns its result", async () => {
    const result = await withSpaceMutex("alpha", "writer", async () => "ok");
    expect(result).toBe("ok");
    expect(inFlightRole("alpha")).toBeNull();
  });

  it("blocks a concurrent run in the same space", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = withSpaceMutex("alpha", "writer", () => gate);
    // Drain the microtask queue so the first call has set inFlight.
    await Promise.resolve();
    expect(inFlightRole("alpha")).toBe("writer");

    await expect(
      withSpaceMutex("alpha", "editor", async () => "second"),
    ).rejects.toBeInstanceOf(SpaceBusyError);

    release!();
    await first;
    expect(inFlightRole("alpha")).toBeNull();
  });

  it("allows concurrent runs across different spaces", async () => {
    let releaseA: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });

    const a = withSpaceMutex("alpha", "writer", () => gateA);
    await Promise.resolve();
    expect(inFlightRole("alpha")).toBe("writer");

    // Different space should not throw.
    const b = await withSpaceMutex("beta", "writer", async () => "b-ok");
    expect(b).toBe("b-ok");

    releaseA!();
    await a;
  });

  it("releases the mutex when the function throws", async () => {
    await expect(
      withSpaceMutex("alpha", "writer", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(inFlightRole("alpha")).toBeNull();

    const second = await withSpaceMutex("alpha", "editor", async () => "ok");
    expect(second).toBe("ok");
  });

  it("SpaceBusyError carries the in-flight role name", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = withSpaceMutex("alpha", "writer", () => gate);
    await Promise.resolve();

    try {
      await withSpaceMutex("alpha", "proposer", async () => "second");
      expect.fail("expected SpaceBusyError");
    } catch (err) {
      expect(err).toBeInstanceOf(SpaceBusyError);
      expect((err as SpaceBusyError).inFlightRole).toBe("writer");
      expect((err as SpaceBusyError).spaceName).toBe("alpha");
    }

    release!();
    await first;
  });

  it("withSpaceMutex reports a queued waiter as busy", async () => {
    // Editor runs via queue; writer queues behind it. An HTTP-style
    // `withSpaceMutex` probe must surface 'busy' (so the operator gets
    // a 409 instead of jumping the queued tick).
    let releaseEditor: () => void;
    const editorGate = new Promise<void>((r) => {
      releaseEditor = r;
    });

    const editorRun = queueSpaceMutex("alpha", "editor", () => editorGate);
    await Promise.resolve();
    expect(inFlightRole("alpha")).toBe("editor");

    // Queue a writer behind the editor.
    let writerStarted = false;
    const writerRun = queueSpaceMutex("alpha", "writer", async () => {
      writerStarted = true;
    });
    await Promise.resolve();
    expect(writerStarted).toBe(false);

    // HTTP probe must 409 — neither editor nor writer should be jumped.
    await expect(
      withSpaceMutex("alpha", "proposer", async () => "manual"),
    ).rejects.toBeInstanceOf(SpaceBusyError);

    releaseEditor!();
    await editorRun;
    await writerRun;
    expect(writerStarted).toBe(true);
    expect(inFlightRole("alpha")).toBeNull();
  });
});

describe("queueSpaceMutex", () => {
  afterEach(() => {
    resetSpaceMutexForTests();
  });

  it("runs immediately when the space is idle", async () => {
    const result = await queueSpaceMutex("alpha", "writer", async () => "ok");
    expect(result).toBe("ok");
    expect(inFlightRole("alpha")).toBeNull();
  });

  it("waits for the in-flight run to finish, then runs in order", async () => {
    const events: string[] = [];
    let releaseEditor: () => void;
    const editorGate = new Promise<void>((r) => {
      releaseEditor = r;
    });

    const editor = queueSpaceMutex("alpha", "editor", async () => {
      events.push("editor:start");
      await editorGate;
      events.push("editor:end");
    });

    // Drain microtasks so the editor has claimed inFlight.
    await Promise.resolve();
    expect(inFlightRole("alpha")).toBe("editor");

    const writer = queueSpaceMutex("alpha", "writer", async () => {
      events.push("writer:start");
      events.push("writer:end");
    });

    // Writer should not have started — editor still holds the slot.
    await Promise.resolve();
    expect(events).toEqual(["editor:start"]);

    releaseEditor!();
    await Promise.all([editor, writer]);

    expect(events).toEqual([
      "editor:start",
      "editor:end",
      "writer:start",
      "writer:end",
    ]);
    expect(inFlightRole("alpha")).toBeNull();
  });

  it("preserves FIFO order across multiple queued runs", async () => {
    const events: string[] = [];
    let releaseA: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });

    const a = queueSpaceMutex("alpha", "a", async () => {
      events.push("a");
      await gateA;
    });
    await Promise.resolve();

    const b = queueSpaceMutex("alpha", "b", async () => {
      events.push("b");
    });
    const c = queueSpaceMutex("alpha", "c", async () => {
      events.push("c");
    });

    releaseA!();
    await Promise.all([a, b, c]);

    expect(events).toEqual(["a", "b", "c"]);
  });

  it("propagates errors from the queued fn and keeps the queue draining", async () => {
    const events: string[] = [];
    let releaseFirst: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = queueSpaceMutex("alpha", "first", async () => {
      await firstGate;
      throw new Error("boom");
    });
    await Promise.resolve();

    const second = queueSpaceMutex("alpha", "second", async () => {
      events.push("second");
    });

    releaseFirst!();
    await expect(first).rejects.toThrow("boom");
    await second;

    expect(events).toEqual(["second"]);
    expect(inFlightRole("alpha")).toBeNull();
  });

  it("queues independently per space", async () => {
    let releaseAlpha: () => void;
    const alphaGate = new Promise<void>((r) => {
      releaseAlpha = r;
    });

    const alpha = queueSpaceMutex("alpha", "writer", () => alphaGate);
    await Promise.resolve();
    expect(inFlightRole("alpha")).toBe("writer");

    // beta is unaffected.
    const beta = await queueSpaceMutex("beta", "writer", async () => "b-ok");
    expect(beta).toBe("b-ok");

    releaseAlpha!();
    await alpha;
  });
});
