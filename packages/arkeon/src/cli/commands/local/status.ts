// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon status` — report the local stack's running state, HTTP
 * health, readiness, whether the Genesis seed has been loaded, and
 * Exit codes:
 *   0 — running + /health and /ready both OK
 *   1 — running but unhealthy or not ready
 *   2 — not running
 */

import type { Command } from "commander";

import { listInstances, unregisterInstance } from "../../lib/instances.js";
import {
  arkeonDir,
  DEFAULT_API_PORT,
  isProcessAlive,
  readPidfile,
  readSecrets,
  removePidfile,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";

interface StatusOptions {
  port?: string;
}

interface EntitiesListResponse {
  entities?: Array<{ id: string; type?: string; properties?: Record<string, unknown> }>;
  next_cursor?: string | null;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the local Arkeon stack's process, health, and seed state")
    .option(
      "--port <port>",
      "API port to probe (defaults to the configured local port)",
      String(DEFAULT_API_PORT),
    )
    .action(async (opts: StatusOptions) => {
      try {
        await runStatus(opts);
      } catch (error) {
        output.error(error, { operation: "status" });
        process.exitCode = 1;
      }
    });
}

async function runStatus(opts: StatusOptions): Promise<void> {
  const port = Number(opts.port ?? DEFAULT_API_PORT);
  const apiUrl = `http://localhost:${port}`;
  const pid = readPidfile();

  // Repo binding state (independent of stack liveness)
  const repoState = loadRepoState();
  const repo = repoState
    ? { initialized: true, space_id: repoState.space_id, space_name: repoState.space_name, api_url: repoState.api_url, actors: Object.keys(repoState.actors) }
    : { initialized: false as const };

  // Not running — still show state_dir + admin key prefix so the user
  // has what they need to bring the stack back up and authenticate.
  if (!pid) {
    const secrets = readSecrets();
    output.result({
      operation: "status",
      state: "not_running",
      state_dir: arkeonDir(),
      admin_key_prefix: secrets ? `${secrets.adminBootstrapKey.slice(0, 8)}...` : null,
      repo,
      hint: "Run `arkeon up` to start the stack.",
    });
    process.exit(2);
  }

  if (!isProcessAlive(pid)) {
    removePidfile();
    const secrets = readSecrets();
    output.result({
      operation: "status",
      state: "not_running",
      reason: "stale_pidfile",
      stale_pid: pid,
      state_dir: arkeonDir(),
      admin_key_prefix: secrets ? `${secrets.adminBootstrapKey.slice(0, 8)}...` : null,
      repo,
    });
    process.exit(2);
  }

  // Running — probe the HTTP surface. We do /health and /ready
  // unauthenticated (they bypass auth middleware) and the entity
  // probe authenticated.
  const health = await probeHealth(`${apiUrl}/health`);
  const ready = await probeHealth(`${apiUrl}/ready`);

  if (!health) {
    output.result({
      operation: "status",
      state: "running_unhealthy",
      pid,
      api_url: apiUrl,
      explorer_url: `${apiUrl}/explore`,
      health: false,
      ready: false,
      state_dir: arkeonDir(),
      repo,
      hint: "Process is alive but /health is not responding. Check `arkeon logs` for errors.",
    });
    process.exit(1);
  }

  // Healthy — do the authenticated probes for seed / LLM state.
  // Use read-only secrets so status doesn't create state if the dir
  // wasn't there (shouldn't happen when a daemon is live, but guard
  // against surprising state creation regardless).
  const secrets = readSecrets();
  if (!secrets) {
    output.result({
      operation: "status",
      state: "running",
      pid,
      api_url: apiUrl,
      explorer_url: `${apiUrl}/explore`,
      health: true,
      ready,
      state_dir: arkeonDir(),
      repo,
      hint: "No secrets.json in the state dir — cannot run authenticated probes. Run `arkeon init` to generate one.",
    });
    process.exit(ready ? 0 : 1);
  }
  const adminKey = secrets.adminBootstrapKey;

  const seedState = await probeSeedLoaded(apiUrl, adminKey);

  // Collect all registered instances and their liveness
  const instances = listInstances().map((inst) => {
    const alive = isProcessAlive(inst.pid);
    if (!alive) unregisterInstance(inst.api_port);
    return { name: inst.name, api_url: inst.api_url, pid: inst.pid, alive, arkeon_home: inst.arkeon_home };
  }).filter((i) => i.alive);

  output.result({
    operation: "status",
    state: "running",
    pid,
    api_url: apiUrl,
    explorer_url: `${apiUrl}/explore`,
    health: true,
    ready,
    seed_loaded: seedState.loaded,
    seed_book_id: seedState.bookId,
    state_dir: arkeonDir(),
    admin_key_prefix: `${adminKey.slice(0, 8)}...`,
    repo,
    instances: instances.length > 0 ? instances : undefined,
  });
  process.exit(ready ? 0 : 1);
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function probeSeedLoaded(
  apiUrl: string,
  adminKey: string,
): Promise<{ loaded: boolean; bookId: string | null }> {
  try {
    const res = await fetch(`${apiUrl}/entities?type=book&limit=20`, {
      headers: { authorization: `ApiKey ${adminKey}` },
    });
    if (!res.ok) return { loaded: false, bookId: null };
    const body = (await res.json()) as EntitiesListResponse;
    const book = body.entities?.find((e) => {
      const label = ((e.properties?.label as string | undefined) ?? "").toLowerCase();
      return label.includes("genesis");
    });
    return { loaded: Boolean(book), bookId: book?.id ?? null };
  } catch {
    return { loaded: false, bookId: null };
  }
}


