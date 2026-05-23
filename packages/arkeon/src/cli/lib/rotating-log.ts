// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Size-capped, rotating log file for the daemon's stdout/stderr.
 *
 * Defense-in-depth against runaway logging: even if some future bug
 * tight-loops `console.log` at thousands of lines per second, total
 * disk usage stays bounded by `maxBytes * (maxFiles + 1)`. Real
 * incident: a misconfigured cron + setTimeout overflow once wrote
 * ~141 GB into a single `arkeon.log` over 10 days.
 *
 * `installRotatingStdLog` replaces `process.stdout.write` and
 * `process.stderr.write` with a wrapper that funnels every write
 * through a `RotatingLog`. Whenever the current file would exceed
 * `maxBytes`, it's renamed to `.1` (older backups shift up; the
 * oldest is dropped) and a fresh one is opened. Writes use
 * `writeSync` so messages can't be lost across a crash mid-write.
 */

import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export interface RotatingLogOptions {
  path: string;
  maxBytes: number;
  /** Number of rotated backups to keep (`<path>.1` ... `<path>.N`). */
  maxFiles: number;
}

export class RotatingLog {
  private fd: number;
  private size: number;

  constructor(private readonly opts: RotatingLogOptions) {
    if (opts.maxBytes <= 0) throw new Error("maxBytes must be > 0");
    if (opts.maxFiles < 0) throw new Error("maxFiles must be >= 0");
    try {
      this.size = statSync(opts.path).size;
    } catch {
      this.size = 0;
    }
    this.fd = openSync(opts.path, "a");
  }

  write(chunk: string | Buffer): void {
    const buf =
      typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
    if (this.size > 0 && this.size + buf.length > this.opts.maxBytes) {
      this.rotate();
    }
    writeSync(this.fd, buf);
    this.size += buf.length;
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }

  private rotate(): void {
    try {
      closeSync(this.fd);
    } catch {
      /* ignore */
    }
    if (this.opts.maxFiles === 0) {
      // No backups requested — truncate by reopening fresh.
      try {
        unlinkSync(this.opts.path);
      } catch {
        /* ignore */
      }
    } else {
      const last = `${this.opts.path}.${this.opts.maxFiles}`;
      if (existsSync(last)) {
        try {
          unlinkSync(last);
        } catch {
          /* race tolerated */
        }
      }
      for (let i = this.opts.maxFiles - 1; i >= 1; i--) {
        const from = `${this.opts.path}.${i}`;
        const to = `${this.opts.path}.${i + 1}`;
        if (existsSync(from)) {
          try {
            renameSync(from, to);
          } catch {
            /* race */
          }
        }
      }
      if (existsSync(this.opts.path)) {
        try {
          renameSync(this.opts.path, `${this.opts.path}.1`);
        } catch {
          /* race */
        }
      }
    }
    this.fd = openSync(this.opts.path, "a");
    this.size = 0;
  }
}

const ENV_MAX_BYTES = "ARKEON_WIKI_LOG_MAX_BYTES";
const ENV_MAX_FILES = "ARKEON_WIKI_LOG_MAX_FILES";

export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_LOG_MAX_FILES = 3; // → 200 MB total cap

let installed = false;

/**
 * Replace `process.stdout.write` and `process.stderr.write` with a
 * rotating sink writing to `path`. Returns a teardown function.
 * Idempotent — a second call while already installed is a no-op that
 * returns a no-op teardown.
 *
 * Env-var overrides for operators:
 *   ARKEON_WIKI_LOG_MAX_BYTES — per-file size cap (bytes)
 *   ARKEON_WIKI_LOG_MAX_FILES — number of rotated backups
 */
export function installRotatingStdLog(path: string): () => void {
  if (installed) return () => {};

  const maxBytes = parsePositiveInt(
    process.env[ENV_MAX_BYTES],
    DEFAULT_LOG_MAX_BYTES,
  );
  const maxFiles = parseNonNegativeInt(
    process.env[ENV_MAX_FILES],
    DEFAULT_LOG_MAX_FILES,
  );

  const log = new RotatingLog({ path, maxBytes, maxFiles });
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  // process.stdout.write supports several call shapes:
  //   (chunk)
  //   (chunk, cb)
  //   (chunk, encoding)
  //   (chunk, encoding, cb)
  // We treat everything as utf-8 (matches console.log defaults),
  // invoke the callback if present, and report success.
  const wrap = (chunk: unknown, ...rest: unknown[]): boolean => {
    log.write(chunk as string | Buffer);
    const last = rest[rest.length - 1];
    if (typeof last === "function") {
      (last as (err?: Error | null) => void)();
    }
    return true;
  };

  // Cast through unknown — the `write` overloads on tty.WriteStream
  // aren't directly assignable from our generic wrapper.
  (process.stdout as unknown as { write: unknown }).write = wrap;
  (process.stderr as unknown as { write: unknown }).write = wrap;
  installed = true;

  return () => {
    (process.stdout as unknown as { write: unknown }).write = origStdoutWrite;
    (process.stderr as unknown as { write: unknown }).write = origStderrWrite;
    log.close();
    installed = false;
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return fallback;
  return n;
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback;
  return n;
}
