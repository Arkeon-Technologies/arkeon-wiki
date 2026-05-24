// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared subprocess plumbing for extractors. Handlers stay short:
 * declarative call to `runSubprocess({cmd, args, signal, timeoutMs})`,
 * everything below the line lives here.
 *
 * - `spawn()` only, never `exec()` — no shell interpretation of args.
 * - Capture stdout in full to a buffer; the HTML is small enough that
 *   streaming buys nothing.
 * - Stderr captured separately and returned as `warnings` (or the
 *   error message on non-zero exit).
 * - Global concurrency cap via a semaphore: prevents a fresh corpus
 *   dump of 100 PDFs from spawning 100 PyMuPDF processes at once.
 *   Default 4, override via `ARKEON_WIKI_INGEST_CONCURRENCY`.
 */

import { spawn } from "node:child_process";

export interface RunSubprocessOptions {
  cmd: string;
  args: readonly string[];
  signal: AbortSignal;
  /** Hard kill after this many milliseconds. Default 120_000. */
  timeoutMs?: number;
  /** Max stdout bytes before we abort. Default 50 MB. */
  maxStdoutBytes?: number;
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
}

export class SubprocessError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "SubprocessError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT = 50 * 1024 * 1024;

function readConcurrencyCap(): number {
  const raw = process.env.ARKEON_WIKI_INGEST_CONCURRENCY;
  if (!raw) return 4;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

/**
 * Global semaphore. Tasks beyond the cap wait on a FIFO queue. Each
 * call returns a `release` thunk the caller must invoke (even on
 * error) — try/finally pattern.
 */
const concurrencySemaphore = (() => {
  const cap = readConcurrencyCap();
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  return {
    cap,
    async acquire(): Promise<() => void> {
      if (inFlight < cap) {
        inFlight += 1;
      } else {
        await new Promise<void>((resolve) => waiters.push(resolve));
        inFlight += 1;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        const next = waiters.shift();
        if (next) next();
      };
    },
  };
})();

export async function runSubprocess(
  opts: RunSubprocessOptions,
): Promise<SubprocessResult> {
  const release = await concurrencySemaphore.acquire();
  try {
    return await spawnAndCapture(opts);
  } finally {
    release();
  }
}

function spawnAndCapture(opts: RunSubprocessOptions): Promise<SubprocessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;

  return new Promise<SubprocessResult>((resolve, reject) => {
    const child = spawn(opts.cmd, [...opts.args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let killReason: string | null = null;

    const finalize = (
      code: number | null,
      err?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (err) {
        reject(err);
      } else if (code !== 0) {
        const reason = killReason
          ? `${killReason}; exit ${code}`
          : `exit ${code}`;
        reject(
          new SubprocessError(
            `${opts.cmd} failed (${reason})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
            code,
            stderr,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    };

    const killWith = (reason: string): void => {
      killReason = reason;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };

    const timer = setTimeout(() => {
      killWith(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const onAbort = (): void => {
      killWith("aborted");
    };

    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        killWith(`stdout exceeded ${maxStdout} bytes`);
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => finalize(null, err));
    child.on("close", (code) => finalize(code));
  });
}

export const _semaphoreForTest = concurrencySemaphore;
