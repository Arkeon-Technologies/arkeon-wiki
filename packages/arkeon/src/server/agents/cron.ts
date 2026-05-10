// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin wrapper around `cron-parser` exposing the two operations the
 * scheduler actually needs: validate an expression at config-load time,
 * and compute the next firing instant from a reference time.
 *
 * Centralising the dep here keeps cron-parser's surface from leaking
 * into the scheduler and gives us one place to swap implementations
 * if we ever outgrow cron's 1-minute resolution.
 */

import { CronExpressionParser } from "cron-parser";

/**
 * Compute the next firing time strictly after `from`. Throws with a
 * clear message if the expression is invalid — callers should validate
 * at config-load time so daemon startup fails fast on a typo rather
 * than at first tick.
 */
export function nextTick(expr: string, from: Date = new Date()): Date {
  const interval = CronExpressionParser.parse(expr, { currentDate: from });
  return interval.next().toDate();
}

/**
 * Validate a cron expression. Returns null if valid, an error message
 * if not. Used by the config layer at load time so we can surface
 * `agents.yaml: roles.X.cron is invalid: ...` instead of crashing the
 * scheduler on first tick.
 */
export function validateCronExpression(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
