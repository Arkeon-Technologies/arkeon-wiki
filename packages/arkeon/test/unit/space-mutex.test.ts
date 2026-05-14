// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  SpaceBusyError,
  inFlightRole,
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
});
