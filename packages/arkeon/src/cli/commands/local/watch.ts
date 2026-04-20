// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon watch` — live dashboard showing extraction and drafting queue
 * progress. Polls GET /queues and redraws the terminal on each tick.
 *
 * Exit codes:
 *   0 — user hit Ctrl+C
 *   1 — stack not running or fetch error
 */

import type { Command } from "commander";

import {
  DEFAULT_API_PORT,
  isProcessAlive,
  readPidfile,
  readSecrets,
} from "../../lib/local-runtime";
import { output } from "../../lib/output";

interface WatchOptions {
  interval?: string;
  json?: boolean;
  port?: string;
}

interface QueueItem {
  entity_id: string;
  label: string | null;
  status: string;
  error: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
}

interface QueueStatus {
  name: string;
  counts: Record<string, number>;
  processing: QueueItem[];
  recent_complete: QueueItem[];
  recent_errors: QueueItem[];
}

interface QueuesResponse {
  queues: QueueStatus[];
  timestamp: string;
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Live dashboard showing extraction and drafting queue progress")
    .option("--interval <seconds>", "Poll interval in seconds", "3")
    .option("--json", "Output one JSON object per tick (for piping)")
    .option(
      "--port <port>",
      "API port to probe",
      String(DEFAULT_API_PORT),
    )
    .action(async (opts: WatchOptions) => {
      try {
        await runWatch(opts);
      } catch (error) {
        output.error(error, { operation: "watch" });
        process.exitCode = 1;
      }
    });
}

async function runWatch(opts: WatchOptions): Promise<void> {
  const port = Number(opts.port ?? DEFAULT_API_PORT);
  const intervalMs = Math.max(1, Number(opts.interval ?? 3)) * 1000;
  const jsonMode = opts.json === true;
  const apiUrl = `http://localhost:${port}`;

  // Verify stack is running
  const pid = readPidfile();
  if (!pid || !isProcessAlive(pid)) {
    output.error(new Error("Stack is not running. Start it with `arkeon up`."), {
      operation: "watch",
    });
    process.exit(1);
  }

  const secrets = readSecrets();
  if (!secrets) {
    output.error(new Error("No secrets.json found. Run `arkeon init` first."), {
      operation: "watch",
    });
    process.exit(1);
  }
  const adminKey = secrets.adminBootstrapKey;

  // SIGINT → clean exit
  process.on("SIGINT", () => process.exit(0));

  // Immediate first tick, then interval
  await tick(apiUrl, adminKey, jsonMode);
  const timer = setInterval(() => void tick(apiUrl, adminKey, jsonMode), intervalMs);
  timer.unref?.();

  // Keep process alive until SIGINT
  await new Promise<void>(() => {});
}

async function tick(
  apiUrl: string,
  adminKey: string,
  jsonMode: boolean,
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${apiUrl}/queues?recent=5`, {
      headers: { authorization: `ApiKey ${adminKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(`[watch] HTTP ${res.status}: ${body.slice(0, 200)}\n`);
      return;
    }

    const data = (await res.json()) as QueuesResponse;

    if (jsonMode) {
      process.stdout.write(JSON.stringify(data) + "\n");
    } else {
      renderDashboard(data);
    }
  } catch (err) {
    process.stderr.write(`[watch] fetch error: ${(err as Error).message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

function renderDashboard(data: QueuesResponse): void {
  // Clear screen + move cursor home
  process.stdout.write("\x1b[2J\x1b[H");

  const ts = new Date(data.timestamp).toLocaleTimeString();
  const lines: string[] = [];

  lines.push(`Arkeon Queue Monitor    ${ts}`);
  lines.push("");

  for (const q of data.queues) {
    lines.push(`${q.name.toUpperCase()}`);
    lines.push(formatCounts(q.counts));

    if (q.processing.length > 0) {
      lines.push("");
      lines.push("  Processing:");
      for (const item of q.processing) {
        lines.push(`    ${itemLabel(item)} (attempt ${item.attempts})`);
      }
    }

    if (q.recent_complete.length > 0 || q.recent_errors.length > 0) {
      lines.push("");
      lines.push("  Recent:");
      for (const item of q.recent_complete) {
        lines.push(`    [complete]     ${itemLabel(item)}    ${timeAgo(item.started_at)}`);
      }
      for (const item of q.recent_errors) {
        const tag = item.status === "undraftable" ? "undraftable" : "failed";
        const reason = item.error ? ` -- ${item.error.slice(0, 60)}` : "";
        lines.push(`    [${tag}]  ${itemLabel(item)}${reason}    ${timeAgo(item.started_at)}`);
      }
    }

    lines.push("");
  }

  lines.push("Ctrl+C to exit");

  process.stdout.write(lines.join("\n") + "\n");
}

function formatCounts(counts: Record<string, number>): string {
  if (Object.keys(counts).length === 0) return "  (empty queue)";
  const parts = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
  return "  " + parts.join("    ");
}

function itemLabel(item: QueueItem): string {
  return item.label ?? item.entity_id.slice(0, 8);
}

function timeAgo(ts: string | null): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return "";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
