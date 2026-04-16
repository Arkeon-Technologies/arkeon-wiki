// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local runtime for the Arkeon stack.
 *
 * Manages the three things `arkeon start` needs to turn up a working
 * Arkeon instance with no Docker and no system-installed services:
 *
 *   1. ~/.arkeon/           — state directory (data, binaries, secrets, pidfile)
 *   2. embedded Postgres    — runs as a child process, data in ~/.arkeon/data/postgres
 *   3. Meilisearch          — binary downloaded on first run, data in ~/.arkeon/data/meili
 *
 * Plus secrets (ADMIN_BOOTSTRAP_KEY, ENCRYPTION_KEY, MEILI_MASTER_KEY) that
 * are generated on first run and persisted in ~/.arkeon/secrets.json so
 * subsequent starts don't rotate keys on users.
 *
 * This module is runtime-only — it doesn't import the API server or
 * tie into startApi(). The `arkeon start` command orchestrates the two.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";

// =====================================================================
// Paths + conventions
// =====================================================================
//
// Paths are exposed as getter functions rather than module-level constants
// so that commands can set `process.env.ARKEON_HOME` (or its --data-dir
// CLI equivalent) at action time and have the subsequent calls observe
// the override. Constants captured at module import time would lock in
// whatever ARKEON_HOME was when the CLI first loaded this module.

function arkeonHome(): string {
  return process.env.ARKEON_HOME ?? join(homedir(), ".arkeon");
}

export function arkeonDir(): string { return arkeonHome(); }
export function dataDir(): string { return join(arkeonHome(), "data"); }
export function pgDataDir(): string { return join(dataDir(), "postgres"); }
export function meiliDataDir(): string { return join(dataDir(), "meili"); }
export function filesDataDir(): string { return join(dataDir(), "files"); }
export function binDir(): string { return join(arkeonHome(), "bin"); }
export function secretsFile(): string { return join(arkeonHome(), "secrets.json"); }
export function pidfile(): string { return join(arkeonHome(), "arkeon.pid"); }
export function meiliPidfile(): string { return join(arkeonHome(), "meili.pid"); }
export function logfile(): string { return join(arkeonHome(), "arkeon.log"); }
export function pendingLlmFile(): string { return join(arkeonHome(), "pending-llm.json"); }

// Meilisearch version pinned for reproducibility. Bump deliberately.
const MEILI_VERSION = "v1.41.0";

// Default ports. Users can override via env.
export const DEFAULT_API_PORT = 8000;
export const DEFAULT_PG_PORT = 5433; // 5433 not 5432 so we don't collide with a user's system Postgres
export const DEFAULT_MEILI_PORT = 7700;

// =====================================================================
// Directory bootstrap
// =====================================================================

export function ensureArkeonDir(): void {
  for (const dir of [arkeonDir(), dataDir(), binDir(), filesDataDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// =====================================================================
// Secrets — generated once, persisted forever
// =====================================================================

export interface ArkeonSecrets {
  adminBootstrapKey: string;
  encryptionKey: string;
  meiliMasterKey: string;
  // Runtime Postgres password. This one doesn't need to be "secret" in
  // the traditional sense — the DB only listens on localhost — but we
  // still generate a random one so the data dir isn't trivially
  // accessible by other users on a shared machine.
  pgPassword: string;
}

/**
 * Read secrets.json if it exists. Returns null when the file is
 * missing. Unlike loadOrCreateSecrets, this never writes to disk —
 * safe to call from status/probe commands where generating state
 * would be surprising.
 */
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
      // Forward-compat: if someone's old secrets.json is missing a new
      // field we added later, fill it in and rewrite.
      const complete: ArkeonSecrets = {
        adminBootstrapKey: parsed.adminBootstrapKey ?? `ak_${randomBytes(32).toString("hex")}`,
        encryptionKey: parsed.encryptionKey ?? randomBytes(32).toString("hex"),
        meiliMasterKey: parsed.meiliMasterKey ?? randomBytes(24).toString("hex"),
        pgPassword: parsed.pgPassword ?? randomBytes(16).toString("hex"),
      };
      if (JSON.stringify(parsed) !== JSON.stringify(complete)) {
        writeFileSync(path, JSON.stringify(complete, null, 2), { mode: 0o600 });
      }
      return complete;
    } catch {
      // Fall through to regenerate — a corrupt secrets file is a bigger
      // problem the user has to know about via reset.
      throw new Error(
        `Failed to parse ${path}. Delete it and run \`arkeon start\` again to regenerate.`,
      );
    }
  }

  const secrets: ArkeonSecrets = {
    adminBootstrapKey: `ak_${randomBytes(32).toString("hex")}`,
    encryptionKey: randomBytes(32).toString("hex"),
    meiliMasterKey: randomBytes(24).toString("hex"),
    pgPassword: randomBytes(16).toString("hex"),
  };
  writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

// =====================================================================
// Meilisearch binary lifecycle
// =====================================================================
//
// Expected SHA256 digests for the v1.41.0 binaries we download. Sourced
// from GitHub's release asset API (`asset.digest` field, prefixed
// `sha256:`). Bump together with MEILI_VERSION whenever the pin moves.
//
//   curl -sL "https://api.github.com/repos/meilisearch/meilisearch/releases/tags/${MEILI_VERSION}" \
//     | python3 -c 'import sys, json; [print(a["name"], "=", a.get("digest")) for a in json.load(sys.stdin)["assets"]]'
//
// If someone ever replaces a release asset in-place (which GitHub
// allows!) this map catches it before we execute a swapped binary.

const MEILI_SHA256: Record<string, string> = {
  "meilisearch-linux-amd64":         "7c94284f47dcbcb2950f5dcb154c396be7157e16d4f4dd600109f3587247dded",
  "meilisearch-linux-aarch64":       "c51d58906b4da862dcd59b9352b93e3590f435caa3da09d2a6aa1d1c2c6405c2",
  "meilisearch-macos-amd64":         "0ddd61465a6291351af3df679cc65a6798d590190fae9069290f4ed7d828c0fd",
  "meilisearch-macos-apple-silicon": "42b5178c6d30e13b2fd71dfd50383eaa5eefd385acf80f5bf67e2c100023b08d",
  "meilisearch-windows-amd64.exe":   "66d16db8d114cd8992ddc71ff7778fff98ac8d8aba1229a5ac6f842995dd3553",
};

function meiliAssetName(): string {
  const p = platform();
  const a = arch();
  if (p === "linux") {
    if (a === "x64") return "meilisearch-linux-amd64";
    if (a === "arm64") return "meilisearch-linux-aarch64";
  } else if (p === "darwin") {
    if (a === "x64") return "meilisearch-macos-amd64";
    if (a === "arm64") return "meilisearch-macos-apple-silicon";
  } else if (p === "win32") {
    if (a === "x64") return "meilisearch-windows-amd64.exe";
  }
  throw new Error(
    `Unsupported platform for Meilisearch binary: ${p}/${a}. ` +
    `Supported: linux x64/arm64, darwin x64/arm64, win32 x64.`,
  );
}

export function meiliBinaryPath(): string {
  const name = platform() === "win32" ? "meilisearch.exe" : "meilisearch";
  return join(binDir(), name);
}

export async function ensureMeiliBinary(): Promise<string> {
  const target = meiliBinaryPath();
  if (existsSync(target)) {
    try {
      if (statSync(target).size > 0) return target;
    } catch {
      // fall through to re-download
    }
  }

  const asset = meiliAssetName();
  const url = `https://github.com/meilisearch/meilisearch/releases/download/${MEILI_VERSION}/${asset}`;
  console.log(`[arkeon] Downloading Meilisearch ${MEILI_VERSION} for ${platform()}/${arch()}`);
  console.log(`         ${url}`);

  // Node's global fetch handles redirects; GitHub uses CDN redirect for release assets.
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Meilisearch: ${response.status} ${response.statusText}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  // Write to a .part file first, then rename — so an interrupted download
  // doesn't leave a truncated binary that looks "installed" on next run.
  const partPath = `${target}.part`;
  const out = createWriteStream(partPath);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, out);

  // Sanity-check size. Meilisearch binaries are ~100MB; anything under 1MB
  // is almost certainly an error page, not a binary.
  const size = statSync(partPath).size;
  if (size < 1024 * 1024) {
    unlinkSync(partPath);
    throw new Error(
      `Downloaded Meilisearch asset was only ${size} bytes — expected a binary. ` +
      `Check your network or retry.`,
    );
  }

  // SHA256 verification. GitHub permits in-place replacement of release
  // assets, so we pin the hash and fail loud if it ever drifts. The
  // hashes in MEILI_SHA256 are derived from the release API's
  // `asset.digest` field at pin time — see the comment on MEILI_SHA256.
  const expectedHash = MEILI_SHA256[asset];
  if (expectedHash) {
    const actualHash = sha256File(partPath);
    if (actualHash !== expectedHash) {
      unlinkSync(partPath);
      throw new Error(
        `Meilisearch binary checksum mismatch for ${asset}:\n` +
        `  expected sha256: ${expectedHash}\n` +
        `  actual sha256:   ${actualHash}\n` +
        `Refusing to install a binary we don't recognize. This is either a transient ` +
        `download corruption (retry) or an indication that the upstream asset has been ` +
        `replaced — in which case MEILI_SHA256 in local-runtime.ts needs to be updated.`,
      );
    }
  } else {
    console.warn(
      `[arkeon] No checksum pinned for ${asset}. Skipping verification — ` +
      `consider adding one to MEILI_SHA256 in local-runtime.ts.`,
    );
  }

  // Rename into place and make it executable on POSIX.
  if (existsSync(target)) unlinkSync(target);
  renameSync(partPath, target);
  if (platform() !== "win32") chmodSync(target, 0o755);

  console.log(`[arkeon] Meilisearch binary installed at ${target}`);
  return target;
}

export function startMeilisearch(opts: {
  port: number;
  masterKey: string;
}): ChildProcess {
  const dbPath = meiliDataDir();
  if (!existsSync(dbPath)) mkdirSync(dbPath, { recursive: true });
  const bin = meiliBinaryPath();
  const child = spawn(
    bin,
    [
      "--db-path",
      dbPath,
      "--http-addr",
      `127.0.0.1:${opts.port}`,
      "--master-key",
      opts.masterKey,
      "--no-analytics",
      "--env",
      "development",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    // Meilisearch is chatty on startup; prefix so it's obvious which
    // process is speaking in the arkeon log.
    process.stdout.write(`[meili] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[meili] ${chunk.toString()}`);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[meili] exited with code ${code} (signal ${signal})`);
    }
    removeMeiliPidfile();
  });

  if (child.pid) writeMeiliPidfile(child.pid);

  return child;
}

export async function waitForMeilisearchReady(
  port: number,
  masterKey: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${masterKey}` },
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Meilisearch did not become healthy within ${timeoutMs}ms`);
}

// =====================================================================
// Embedded Postgres lifecycle
// =====================================================================

export interface PgHandle {
  /** Connection string for the runtime application role (arke_app). */
  appUrl: string;
  /** Connection string for the superuser (used for migrations). */
  superUrl: string;
  /** Stop the server. */
  stop: () => Promise<void>;
}

export async function startEmbeddedPostgres(opts: {
  port: number;
  password: string;
}): Promise<PgHandle> {
  const pgData = pgDataDir();
  const alreadyInitialised = existsSync(join(pgData, "PG_VERSION"));

  // embedded-postgres stores data in `databaseDir`. If this is the first
  // start, it runs initdb; subsequent starts reuse the existing cluster.
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

  // First-run only: create the `arke` database owned by the `arke` user.
  // embedded-postgres creates a default `postgres` database; our schema
  // lives in `arke` to match production layout.
  if (!alreadyInitialised) {
    try {
      await pg.createDatabase("arke");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("already exists")) throw err;
    }
  }

  // The arke_app role is created by packages/schema/001-roles.sql at
  // migration time, so we don't create it here. The migration reads
  // its password from ARKE_APP_PASSWORD, which the caller must set.
  //
  // For the runtime application URL, we build a string that will work
  // *after* migrations run. During migrations, the caller uses superUrl.
  const superUrl = `postgresql://arke:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/arke`;
  const appUrl = `postgresql://arke_app:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/arke`;

  return {
    appUrl,
    superUrl,
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
    // Signal 0 doesn't send anything, just checks existence + permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means it exists but we can't signal it — still "alive"
    return code === "EPERM";
  }
}

// =====================================================================
// Meilisearch pidfile — tracks the child so we can kill orphans
// =====================================================================

export function writeMeiliPidfile(pid: number): void {
  writeFileSync(meiliPidfile(), String(pid), "utf-8");
}

export function removeMeiliPidfile(): void {
  const path = meiliPidfile();
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Kill a Meilisearch process orphaned by a previous crash / kill -9.
 * Reads meili.pid, checks if the process is alive, sends SIGTERM, and
 * waits up to 5s for it to exit. No-op if the pidfile is missing or
 * the process is already dead.
 */
export async function killOrphanedMeilisearch(): Promise<void> {
  const path = meiliPidfile();
  if (!existsSync(path)) return;

  const raw = readFileSync(path, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    removeMeiliPidfile();
    return;
  }

  if (!isProcessAlive(pid)) {
    removeMeiliPidfile();
    return;
  }

  console.log(`[arkeon] Killing orphaned Meilisearch (pid ${pid})`);
  try {
    if (platform() === "win32") {
      process.kill(pid);
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (err) {
    console.warn(`[arkeon] Could not signal Meilisearch pid ${pid}: ${(err as Error).message}`);
    removeMeiliPidfile();
    return;
  }

  // Wait up to 5s for graceful exit, then SIGKILL
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isProcessAlive(pid)) {
    console.warn(`[arkeon] Meilisearch pid ${pid} did not exit in 5s — sending SIGKILL`);
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  removeMeiliPidfile();
}

// =====================================================================
// Orphaned Postgres cleanup
// =====================================================================

/**
 * Kill an embedded Postgres orphaned by a crash / kill -9. Reads the PID
 * from the standard `postmaster.pid` in the data directory (line 1 is the
 * PID). Sends SIGTERM and waits up to 5s. No-op if the file is missing or
 * the process is dead.
 */
export async function killOrphanedPostgres(): Promise<void> {
  const pmPid = join(pgDataDir(), "postmaster.pid");
  if (!existsSync(pmPid)) return;

  const raw = readFileSync(pmPid, "utf-8").trim();
  const firstLine = raw.split("\n")[0]?.trim();
  const pid = Number(firstLine);
  if (!Number.isFinite(pid) || pid <= 0) return;

  if (!isProcessAlive(pid)) {
    // Stale lockfile — Postgres is gone but didn't clean up.
    // Remove it so the next start doesn't fail.
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

  // Wait up to 5s for graceful exit, then SIGKILL and remove lockfile
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isProcessAlive(pid)) {
    console.warn(`[arkeon] Postgres pid ${pid} did not exit in 5s — sending SIGKILL`);
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    // SIGKILL won't let Postgres clean up its own lockfile
    try { unlinkSync(pmPid); } catch { /* ignore */ }
  }
}

// =====================================================================
// Port availability check
// =====================================================================

/**
 * Returns true if something is already listening on the given port.
 * Uses a quick TCP connect probe — fails fast (~100ms) if nothing is there.
 */
export function isPortInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host, timeout: 500 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });
}

// =====================================================================
// Sha256 helper for binary checksums (future use)
// =====================================================================

export function sha256File(path: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

// =====================================================================
// URL-safe fmt helper to build Postgres URLs with percent-encoded pw.
// (postgres.js handles % encoding fine if we do it ourselves.)
// =====================================================================

export function fmtPgUrl(
  user: string,
  password: string,
  host: string,
  port: number,
  db: string,
): string {
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

// =====================================================================
// Pending LLM config (written by `arkeon init`, consumed by `arkeon up`)
// =====================================================================
//
// One-shot carrier for the LLM provider settings collected at init time,
// applied against the running API by `arkeon up` once /health is green.
//
// Persisted to ~/.arkeon/pending-llm.json with mode 0600. The file is
// deleted on successful apply; `arkeon reset` wipes it along with the
// rest of the data directory so stale creds never linger.

export interface PendingLlmConfig {
  /** Free-form provider label — "openai", "anthropic", "openrouter", etc. */
  provider: string;
  /** OpenAI-compatible base URL. No defaults. */
  base_url: string;
  /** API key for the provider. */
  api_key: string;
  /** Model identifier — "gpt-4.1-nano", "claude-3-5-sonnet-20241022", etc. */
  model: string;
}

export function readPendingLlm(): PendingLlmConfig | null {
  const path = pendingLlmFile();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PendingLlmConfig;
  } catch {
    return null;
  }
}

export function writePendingLlm(cfg: PendingLlmConfig): void {
  const path = pendingLlmFile();
  if (!existsSync(arkeonHome())) mkdirSync(arkeonHome(), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // Belt-and-suspenders — writeFileSync's `mode` only applies on create.
  if (platform() !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // ignore — happens if another process grabbed it between write + chmod
    }
  }
}

export function clearPendingLlm(): void {
  const path = pendingLlmFile();
  if (existsSync(path)) unlinkSync(path);
}

// =====================================================================
// Resolve the CLI entry point for spawning `arkeon start` as a detached
// child process during `arkeon up`.
// =====================================================================
//
// The child needs to run the SAME code that the parent is running, from
// the same package, so there's no version skew between a user's globally
// installed `arkeon` and the one they just invoked.
//
// Three layouts we care about:
//   1. Monorepo dev (tsx) — import.meta.url points at
//      packages/cli/src/lib/local-runtime.ts. Spawn via `npx tsx` at
//      packages/cli/src/index.ts so the child also runs through tsx.
//   2. Published npm / tsup-bundled — import.meta.url points inside
//      packages/cli/dist/index.js (everything gets inlined into one
//      file). Spawn via `node` at that same path.
//   3. Global install — `npm install -g arkeon` puts a symlink at
//      <prefix>/bin/arkeon pointing at node_modules/arkeon/dist/index.js.
//      Same as #2 for this code's purposes.

export function findCliEntry(): { cmd: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));

  // Bundled case: we're inside packages/cli/dist/index.js (or the
  // corresponding published location). The bundled entry is a sibling
  // of this file's parent.
  const bundledCandidates = [
    join(here, "index.js"),              // same dir (if everything flattens)
    join(here, "..", "index.js"),        // src → dist fallback (future-proofing)
  ];
  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) {
      return { cmd: process.execPath, args: [candidate] };
    }
  }

  // Monorepo dev case: check both the old layout (cli/index.ts) and the
  // flattened layout (src/index.ts — two levels up from lib/local-runtime.ts).
  const devCandidates = [
    join(here, "..", "index.ts"),            // cli/lib → cli/index.ts (old layout)
    join(here, "..", "..", "index.ts"),       // cli/lib → src/index.ts (flattened)
  ];
  for (const candidate of devCandidates) {
    if (existsSync(candidate)) {
      return { cmd: "npx", args: ["tsx", candidate] };
    }
  }

  // Last-resort fallback: ask the shell to find the installed binary.
  // Useful when a user has both a global `arkeon` and is running via a
  // weird setup we didn't think of.
  return { cmd: "arkeon", args: [] };
}
