// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local runtime for the Arkeon stack.
 *
 * Manages the things `arkeon-wiki start` needs:
 *   1. ~/.arkeon-wiki/      — state directory (data, pidfile)
 *   2. SQLite database      — single file at ~/.arkeon-wiki/data/arke.db
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// =====================================================================
// Paths
// =====================================================================

function arkeonHome(): string {
  return process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
}

export function arkeonDir(): string { return arkeonHome(); }
export function dataDir(): string { return join(arkeonHome(), "data"); }
export function dbPath(): string { return join(dataDir(), "arke.db"); }
export function pidfile(): string { return join(arkeonHome(), "arkeon.pid"); }
export function logfile(): string { return join(arkeonHome(), "arkeon.log"); }

export const DEFAULT_API_PORT = 8000;

// =====================================================================
// Named instances
// =====================================================================

/**
 * Deterministic port offset from instance name. Maps to slot 1–999 so
 * `--name foo` always picks the same port across machines/runs.
 */
export function nameToPortSlot(name: string): number {
  const hash = createHash("sha256").update(name).digest();
  return ((hash[0]! << 8 | hash[1]!) % 999) + 1;
}

/**
 * State directory for a named instance: `~/.arkeon-wiki/<name>`. The
 * default (no name) lives directly under `~/.arkeon-wiki/`.
 */
export function homeForName(name: string): string {
  return join(homedir(), ".arkeon-wiki", name);
}

/**
 * Apply --name semantics:
 *   1. Set ARKEON_WIKI_HOME to ~/.arkeon-wiki/<name> (unless already set
 *      by --data-dir, which wins).
 *   2. Return the derived port (DEFAULT_API_PORT + slot).
 *
 * Path helpers in this module read ARKEON_WIKI_HOME at call time, so
 * setting it here propagates through `dbPath()`, `pidfile()`, etc.
 */
export function applyName(name: string): { port: number; home: string } {
  const home = homeForName(name);
  if (!process.env.ARKEON_WIKI_HOME) {
    process.env.ARKEON_WIKI_HOME = home;
  }
  return { port: DEFAULT_API_PORT + nameToPortSlot(name), home };
}

// =====================================================================
// Directory bootstrap
// =====================================================================

export function ensureArkeonDir(): void {
  for (const dir of [arkeonDir(), dataDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// =====================================================================
// Pidfile management
// =====================================================================

export function writePidfile(pid: number): void {
  writeFileSync(pidfile(), String(pid), "utf-8");
}

export function readPidfile(): number | null {
  const path = pidfile();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function removePidfile(): void {
  const path = pidfile();
  if (existsSync(path)) unlinkSync(path);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Test whether a TCP port is currently accepting connections on
 * localhost. Used by `up` to fail fast if the requested port is
 * squatted, instead of spawning a daemon that crashes with EADDRINUSE
 * while another service (potentially with its own /health endpoint)
 * keeps responding.
 *
 * We attempt a connect (not a listen) because a listen-based check
 * misses dual-stack mismatches: a server bound to `::` doesn't appear
 * occupied to a fresh `127.0.0.1` listener on macOS.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED is the only definitive "free" signal — nothing was
      // listening to even refuse us. Anything else (ECONNRESET from a
      // half-open socket, host unreachable, etc.) means something *is*
      // there or we can't tell, so we err on the side of "in use" rather
      // than letting the spawned daemon crash silently behind a squatter.
      settle(err.code !== "ECONNREFUSED");
    });
    socket.setTimeout(500, () => settle(false));
  });
}

// =====================================================================
// CLI entry point resolution (for `arkeon up` → detached `arkeon start`)
// =====================================================================

export function findCliEntry(): { cmd: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));

  const bundledCandidates = [
    join(here, "index.js"),
    join(here, "..", "index.js"),
  ];
  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) {
      return { cmd: process.execPath, args: [candidate] };
    }
  }

  const devCandidates = [
    join(here, "..", "index.ts"),
    join(here, "..", "..", "index.ts"),
  ];
  for (const candidate of devCandidates) {
    if (existsSync(candidate)) {
      return { cmd: "npx", args: ["tsx", candidate] };
    }
  }

  return { cmd: "arkeon-wiki", args: [] };
}
