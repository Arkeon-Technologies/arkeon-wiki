// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured agent run traces.
 *
 * Off by default. Set ARKEON_WIKI_AGENT_TRACE=1 to enable. The tracer
 * appends one JSON object per line to a file (default
 * `<arkeonHome>/agent-trace.jsonl`, override with
 * ARKEON_WIKI_AGENT_TRACE_FILE) describing the lifecycle of every
 * `runAgent` call: which subjects the agent looked up, which tools it
 * called with what arguments, what it edited and how, token usage per
 * phase, errors. Read it back with `jq`.
 *
 * Tracing must never break a run. All file I/O is best-effort — a
 * failed write logs once and disables the writer for the rest of the
 * process so we don't spam stderr.
 *
 * The schema is intentionally not versioned. It's a debug-time stream;
 * if we change the shape, we change the consumers (jq queries, test
 * harnesses) along with it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface TraceEvent {
  /** Short event name, e.g. "run.start", "tool.call", "edit", "run.end". */
  event: string;
  /** Per-call fields. The writer adds `ts` automatically. */
  [key: string]: unknown;
}

export interface Tracer {
  enabled: boolean;
  emit(event: TraceEvent): void;
}

// ── Public surface ────────────────────────────────────────────────

/** Singleton tracer for this process. Lazy: doesn't touch the FS until
 *  the first emit. Reads env at first call (process-stable). */
export function getTracer(): Tracer {
  if (cached === undefined) cached = build();
  return cached;
}

/** Test helper: forget the cached tracer so a subsequent getTracer()
 *  re-reads env. Not for production use. */
export function _resetTracerForTests(): void {
  cached = undefined;
}

// ── Implementation ────────────────────────────────────────────────

let cached: Tracer | undefined;

function build(): Tracer {
  if (!isEnabled()) {
    return {
      enabled: false,
      emit: () => {},
    };
  }

  const filePath = resolveFilePath();
  let live = true;
  let dirEnsured = false;

  return {
    enabled: true,
    emit(event: TraceEvent): void {
      if (!live) return;
      try {
        if (!dirEnsured) {
          mkdirSync(dirname(filePath), { recursive: true });
          dirEnsured = true;
        }
        const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
        appendFileSync(filePath, line + "\n");
      } catch (err) {
        live = false;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[agent/tracer] disabling trace file (${filePath}): ${msg}`,
        );
      }
    },
  };
}

function isEnabled(): boolean {
  const v = process.env.ARKEON_WIKI_AGENT_TRACE;
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower !== "" && lower !== "0" && lower !== "false" && lower !== "no";
}

function resolveFilePath(): string {
  const override = process.env.ARKEON_WIKI_AGENT_TRACE_FILE;
  if (override && override.length > 0) return override;
  const home = process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
  return join(home, "agent-trace.jsonl");
}

// ── Helpers consumers can reuse ───────────────────────────────────

/**
 * Truncate a value for tracing. Stringifies, slices to `max` chars, and
 * if the string was clipped returns `{value, truncated: true, full_chars}`
 * instead so consumers can spot incomplete records.
 */
export function truncateForTrace(
  value: unknown,
  max = 500,
): unknown {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= max) return value;
  return {
    value: s.slice(0, max),
    truncated: true,
    full_chars: s.length,
  };
}
