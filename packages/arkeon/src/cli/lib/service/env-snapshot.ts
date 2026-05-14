// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manage ~/.arkeon-wiki/.env on behalf of `install`.
 *
 * The supervisor (launchd / systemd) does not inherit the user's shell
 * environment. Without a persisted .env file, the daemon would start
 * after reboot but agents couldn't authenticate (no OPENAI_API_KEY).
 *
 * The runtime already loads `~/.arkeon-wiki/.env` via
 * `server/agents/env-loader.ts:42` — we don't need to invent a loader.
 * Install's job is to ensure the file exists and contains the keys the
 * user expects, *without ever overwriting an existing value*.
 *
 * Idempotent and non-destructive:
 *
 *   - If a key already lives in the file (any value, including empty),
 *     leave it alone. We don't know if the user has rotated it.
 *   - If a key isn't in the file but is set in the shell, append it.
 *   - If a key is neither in the file nor in the shell, record it as
 *     `missing` so the install command can warn but proceed.
 *
 * Format: standard dotenv — `KEY=value` per line, `#` line comments,
 * blank lines preserved. We never reformat existing lines.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Mode bits for the user-global env file. 0600 = owner read/write
 * only; other users on the machine cannot read it. The plist
 * deliberately omits secrets (multi-user Macs make plists
 * world-readable); the redirect target must apply the same standard.
 */
const ENV_FILE_MODE = 0o600;

export interface SnapshotEnvOptions {
  /** Keys to consider, in user-visible order. e.g. ["OPENAI_API_KEY"]. */
  keys: string[];
  /** Path to the .env file we manage. */
  envFilePath: string;
  /** Source of values. Defaults to `process.env`. */
  shellEnv?: NodeJS.ProcessEnv;
  /** If false, compute the plan but don't write anything. */
  apply?: boolean;
}

export interface SnapshotEnvResult {
  /** Keys we appended this call. */
  written: string[];
  /** Keys already present in the file — left untouched. */
  preserved: string[];
  /** Keys not in the file and not in the shell — neither writable nor preserved. */
  missing: string[];
  /** Filesystem path we read/wrote. */
  envFilePath: string;
}

/**
 * Read an env file into a `{key: value}` record. Returns an empty map
 * if the file doesn't exist. Preserves *which keys are defined*; we
 * don't use the values, only their presence, so the parser is
 * intentionally permissive — anything that looks like `KEY=` at the
 * start of a non-comment line counts.
 */
export function readEnvKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  const text = readFileSync(path, "utf-8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    // Strip optional `export ` prefix common in shell-style dotenvs.
    const cleaned = key.startsWith("export ") ? key.slice("export ".length).trim() : key;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) keys.add(cleaned);
  }
  return keys;
}

/**
 * Compute and (optionally) apply the snapshot. Pure when `apply:false`
 * — exposes the plan for the install command to print before touching
 * disk.
 */
export function snapshotEnv(opts: SnapshotEnvOptions): SnapshotEnvResult {
  const shell = opts.shellEnv ?? process.env;
  const apply = opts.apply ?? true;

  const existing = readEnvKeys(opts.envFilePath);
  const written: string[] = [];
  const preserved: string[] = [];
  const missing: string[] = [];

  const toAppend: Array<[string, string]> = [];
  for (const key of opts.keys) {
    if (existing.has(key)) {
      preserved.push(key);
      continue;
    }
    const value = shell[key];
    if (value === undefined || value === "") {
      missing.push(key);
      continue;
    }
    toAppend.push([key, value]);
    written.push(key);
  }

  if (apply && toAppend.length > 0) {
    ensureDir(opts.envFilePath);
    const lines = toAppend.map(([k, v]) => `${k}=${quoteIfNeeded(v)}`).join("\n");
    const prefix = existsSync(opts.envFilePath)
      ? needsLeadingNewline(opts.envFilePath) ? "\n" : ""
      : "";
    appendFileSync(opts.envFilePath, `${prefix}${lines}\n`, "utf-8");
  } else if (apply && !existsSync(opts.envFilePath)) {
    // Create an empty file so the env-loader's existsSync check
    // doesn't keep returning false — purely cosmetic but matches the
    // user's mental model of "the file is there".
    ensureDir(opts.envFilePath);
    writeFileSync(opts.envFilePath, "", "utf-8");
  }

  // Always tighten perms on a real run, even when no new keys were
  // written and the file existed already. The reviewer's framing: if
  // a user populated this file by hand with permissive defaults
  // (0644), install should bring it to the standard 0600. Re-running
  // install is idempotent — chmod to the same mode is a no-op.
  if (apply && existsSync(opts.envFilePath)) {
    chmodSync(opts.envFilePath, ENV_FILE_MODE);
  }

  return {
    written,
    preserved,
    missing,
    envFilePath: opts.envFilePath,
  };
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function needsLeadingNewline(path: string): boolean {
  try {
    const text = readFileSync(path, "utf-8");
    return text.length > 0 && !text.endsWith("\n");
  } catch {
    return false;
  }
}

/**
 * Quote a value when it contains characters dotenv parsers interpret
 * specially. Conservative: any whitespace, `#`, `=`, `'`, `"`, or
 * shell-meta gets double-quoted with embedded `"` and `\` escaped.
 */
function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@+\-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
