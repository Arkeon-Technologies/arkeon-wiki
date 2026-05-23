// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MAX_SET_TIMEOUT_MS,
  computeScheduleDelay,
} from "../../src/server/agents/scheduler.js";

describe("computeScheduleDelay", () => {
  it("returns the raw delta when within setTimeout's 32-bit limit", () => {
    const now = new Date("2026-05-23T15:00:00Z");
    const nextAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour out
    const { delayMs, capped } = computeScheduleDelay(nextAt, now);
    expect(delayMs).toBe(60 * 60 * 1000);
    expect(capped).toBe(false);
  });

  it("clamps to zero when nextAt is already in the past", () => {
    const now = new Date("2026-05-23T15:00:00Z");
    const nextAt = new Date(now.getTime() - 1000);
    const { delayMs, capped } = computeScheduleDelay(nextAt, now);
    expect(delayMs).toBe(0);
    expect(capped).toBe(false);
  });

  it("caps and flags delays beyond the 32-bit setTimeout limit", () => {
    // 355-day delta from the real incident: node's setTimeout would
    // overflow to 1 ms and trigger a tight loop.
    const now = new Date("2026-05-13T22:25:00Z");
    const nextAt = new Date(now.getTime() + 30_705_909_782);
    const { delayMs, capped } = computeScheduleDelay(nextAt, now);
    expect(capped).toBe(true);
    expect(delayMs).toBe(MAX_SET_TIMEOUT_MS);
  });

  it("does not cap exactly at the limit", () => {
    const now = new Date("2026-05-23T15:00:00Z");
    const nextAt = new Date(now.getTime() + MAX_SET_TIMEOUT_MS);
    const { delayMs, capped } = computeScheduleDelay(nextAt, now);
    expect(capped).toBe(false);
    expect(delayMs).toBe(MAX_SET_TIMEOUT_MS);
  });
});
