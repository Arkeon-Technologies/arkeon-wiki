// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { nextTick, validateCronExpression } from "../../src/server/agents/cron.js";

describe("validateCronExpression", () => {
  it("accepts standard 5-field expressions", () => {
    expect(validateCronExpression("*/15 * * * *")).toBeNull();
    expect(validateCronExpression("0 */6 * * *")).toBeNull();
    expect(validateCronExpression("0 3 * * *")).toBeNull();
    expect(validateCronExpression("30 9 * * 1-5")).toBeNull();
  });

  it("returns an error message for malformed input", () => {
    expect(validateCronExpression("not a cron")).not.toBeNull();
    expect(validateCronExpression("*/15")).not.toBeNull();
    expect(validateCronExpression("60 * * * *")).not.toBeNull();
  });
});

describe("nextTick", () => {
  it("computes the next firing strictly after the reference time", () => {
    const from = new Date("2026-05-10T00:00:00Z");
    const next = nextTick("*/15 * * * *", from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    // Every-15-minutes from 00:00 → 00:15
    expect(next.toISOString()).toBe("2026-05-10T00:15:00.000Z");
  });

  it("rolls forward across hour and day boundaries", () => {
    // 23:51 → next 0/15 firing is 00:00 the next day (cron-parser
    // does not include 23:55 because */15 from 0 means 0,15,30,45).
    const from = new Date("2026-05-10T23:51:00Z");
    const next = nextTick("*/15 * * * *", from);
    expect(next.toISOString()).toBe("2026-05-11T00:00:00.000Z");
  });

  it("throws on a malformed expression", () => {
    expect(() => nextTick("nonsense", new Date())).toThrow();
  });
});
