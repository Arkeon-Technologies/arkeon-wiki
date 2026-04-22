// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local runtime for the Arkeon stack.
 *
 * Manages the things `arkeon-wiki start` needs:
 *   1. ~/.arkeon-wiki/      — state directory (data, secrets, pidfile)
 *   2. embedded Postgres    — runs as a child process, data in ~/.arkeon-wiki/data/postgres
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";

// =====================================================================
// Paths
// =====================================================================

function arkeonHome(): string {
  return process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
}

export function arkeonDir(): string { return arkeonHome(); }
export function dataDir(): string { return join(arkeonHome(), "data"); }
export function pgDataDir(): string { return join(dataDir(), "postgres"); }
export function secretsFile(): string { return join(arkeonHome(), "secrets.json"); }
export function pidfile(): string { return join(arkeonHome(), "arkeon.pid"); }
export function logfile(): string { return join(arkeonHome(), "arkeon.log"); }

export const DEFAULT_API_PORT = 8000;
export const DEFAULT_PG_PORT = 5433;

// =====================================================================
// Directory bootstrap
// =====================================================================

export function ensureArkeonDir(): void {
  for (const dir of [arkeonDir(), dataDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// =====================================================================
// Secrets
// =====================================================================

export interface ArkeonSecrets {
  pgPassword: string;
}

export function readSecrets(): ArkeonSecrets | null {
  const path = secretsFile();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ArkeonSecrets;
  } catch {
    return null;
  }
}

export function loadOrCreateSecrets(): ArkeonSecrets {
  const path = secretsFile();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ArkeonSecrets;
      const complete: ArkeonSecrets = {
        pgPassword: parsed.pgPassword ?? randomBytes(16).toString("hex"),
      };
      if (JSON.stringify(parsed) !== JSON.stringify(complete)) {
        writeFileSync(path, JSON.stringify(complete, null, 2), { mode: 0o600 });
      }
      return complete;
    } catch {
      throw new Error(
        `Failed to parse ${path}. Delete it and run \`arkeon-wiki start\` again to regenerate.`,
      );
    }
  }

  const secrets: ArkeonSecrets = {
    pgPassword: randomBytes(16).toString("hex"),
  };
  writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

// =====================================================================
// Embedded Postgres lifecycle
// =====================================================================

export interface PgHandle {
  url: string;
  stop: () => Promise<void>;
}

export async function startEmbeddedPostgres(opts: {
  port: number;
  password: string;
}): Promise<PgHandle> {
  const pgData = pgDataDir();
  const alreadyInitialised = existsSync(join(pgData, "PG_VERSION"));

  const pg = new EmbeddedPostgres({
    databaseDir: pgData,
    user: "arke",
    password: opts.password,
    port: opts.port,
    persistent: true,
  });

  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();

  if (!alreadyInitialised) {
    try {
      await pg.createDatabase("arke");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("already exists")) throw err;
    }
  }

  const url = `postgresql://arke:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/arke`;

  return {
    url,
    stop: async () => {
      try {
        await pg.stop();
      } catch (err) {
        console.warn("[pg] stop error:", (err as Error).message);
      }
    },
  };
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

// =====================================================================
// Orphaned Postgres cleanup
// =====================================================================

export async function killOrphanedPostgres(): Promise<void> {
  const pmPid = join(pgDataDir(), "postmaster.pid");
  if (!existsSync(pmPid)) return;

  const raw = readFileSync(pmPid, "utf-8").trim();
  const firstLine = raw.split("\n")[0]?.trim();
  const pid = Number(firstLine);
  if (!Number.isFinite(pid) || pid <= 0) return;

  if (!isProcessAlive(pid)) {
    try { unlinkSync(pmPid); } catch { /* ignore */ }
    return;
  }

  console.log(`[arkeon] Killing orphaned Postgres (pid ${pid})`);
  try {
    if (platform() === "win32") {
      process.kill(pid);
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (err) {
    console.warn(`[arkeon] Could not signal Postgres pid ${pid}: ${(err as Error).message}`);
    return;
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isProcessAlive(pid)) {
    console.warn(`[arkeon] Postgres pid ${pid} did not exit in 5s — sending SIGKILL`);
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    try { unlinkSync(pmPid); } catch { /* ignore */ }
  }
}

// =====================================================================
// Port availability check
// =====================================================================

export function isPortInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host, timeout: 500 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
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
