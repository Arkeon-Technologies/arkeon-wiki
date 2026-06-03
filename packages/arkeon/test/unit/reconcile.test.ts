// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-function tests for the reconcile-interval env parsing. The
 * single-flight lock + actual sweep behavior is exercised by
 * test/e2e/reconcile.test.ts where a real DB + watched root are
 * available.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  resolveReconcileIntervalMs,
} from "../../src/server/lib/reconcile.js";

describe("resolveReconcileIntervalMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the default when env value is undefined", () => {
    expect(resolveReconcileIntervalMs(undefined)).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
  });

  it("returns the default when env value is the empty string", () => {
    // dotenv parsers sometimes hand back "" for unset-but-declared keys;
    // treat the same as undefined.
    expect(resolveReconcileIntervalMs("")).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
  });

  it("returns 0 when env value is explicitly '0' (disabled)", () => {
    expect(resolveReconcileIntervalMs("0")).toBe(0);
  });

  it("parses integer seconds → ms", () => {
    expect(resolveReconcileIntervalMs("60")).toBe(60_000);
    expect(resolveReconcileIntervalMs("5")).toBe(5_000);
  });

  it("parses fractional seconds → ms (floored)", () => {
    expect(resolveReconcileIntervalMs("1.5")).toBe(1_500);
  });

  it("clamps sub-second positives up to 1s (avoid CPU peg)", () => {
    expect(resolveReconcileIntervalMs("0.001")).toBe(1_000);
    expect(resolveReconcileIntervalMs("0.5")).toBe(1_000);
  });

  it("falls back to default + warns on garbage input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveReconcileIntervalMs("not-a-number")).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS");
  });

  it("falls back to default + warns on negative numbers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveReconcileIntervalMs("-5")).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("respects a custom default override", () => {
    expect(resolveReconcileIntervalMs(undefined, 99_999)).toBe(99_999);
  });
});
