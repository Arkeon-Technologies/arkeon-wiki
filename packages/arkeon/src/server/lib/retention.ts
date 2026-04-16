// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process retention scheduler.
 *
 * Replaces the pg_cron jobs that used to live in migrations 010/014/017.
 * We moved these out of Postgres because pg_cron is a loadable extension
 * not available in embedded Postgres, Neon serverless, or most managed
 * Postgres offerings. Running them in Node keeps retention working
 * everywhere the API runs.
 *
 * Behavior:
 *   - Each job deletes rows older than its retention window.
 *   - The interval is fixed at 1 hour — frequent enough that deletes are
 *     small batches, infrequent enough that we don't thrash the DB. The
 *     retention window itself is what users care about, not the sweep
 *     cadence.
 *   - Runs in admin context (see withSystemActorContext) because the
 *     RLS DELETE policies on these tables only admit admin.
 *   - On the first tick, we log a summary so operators know retention
 *     is actually running. Subsequent ticks are silent unless something
 *     deletes > 0 rows or errors.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

type RetentionJob = {
  name: string;
  /** Plain English, shown in logs. */
  description: string;
  /** A function that runs the delete and returns rows deleted. */
  run: () => Promise<number>;
};

const jobs: RetentionJob[] = [];

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runAllJobs(): Promise<void> {
  if (running) return; // previous sweep still in flight — skip
  running = true;
  try {
    for (const job of jobs) {
      try {
        const deleted = await job.run();
        if (deleted > 0) {
          console.log(`[retention] ${job.name}: deleted ${deleted} row(s)`);
        }
      } catch (err) {
        console.error(`[retention] ${job.name} failed:`, err);
      }
    }
  } finally {
    running = false;
  }
}

export function startRetention(): void {
  if (timer) return;
  if (jobs.length === 0) return;
  console.log(`[retention] started — ${jobs.length} job(s), hourly sweep`);
  // Kick off an immediate sweep so operators can confirm it's wired up,
  // then settle into the hourly cadence.
  void runAllJobs();
  timer = setInterval(() => {
    void runAllJobs();
  }, ONE_HOUR_MS);
  // Don't keep the Node event loop alive solely for retention.
  timer.unref?.();
}

export function stopRetention(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
