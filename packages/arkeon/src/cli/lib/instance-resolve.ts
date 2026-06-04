// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve which arkeon-wiki daemon a CLI command should talk to.
 *
 * The CLI is run from many places: inside a watched corpus, outside
 * one, with explicit `--api-url` overrides, etc. This module is the
 * single source of truth for "given the user's flags, env, and CWD,
 * what daemon do we hit?"
 *
 * Lookup is read-only — it consults the on-disk registry written by
 * `start.ts` and never spawns or contacts the daemon.
 */

import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import {
  DEFAULT_INSTANCE_NAME,
  findInstance,
  type Instance,
  listInstances,
} from "./instances.js";

/**
 * Resolve `p` to an absolute path, then chase symlinks. Required for
 * macOS, where `/var` is a symlink to `/private/var` and `/tmp` to
 * `/private/tmp` — a watch_dir like `/var/folders/.../corpus` won't
 * string-match `process.cwd()` of `/private/var/folders/.../corpus`
 * without this step. Falls back to plain resolve() when the path
 * doesn't exist (test fixtures, deleted dirs).
 */
function canonicalize(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export interface ResolveOptions {
  /** From `--api-url` flag. */
  apiUrl?: string;
  /** From `--name` flag. */
  name?: string;
  /** Defaults to process.cwd(). Carved out for unit testability. */
  cwd?: string;
  /** Defaults to process.env. Carved out for unit testability. */
  env?: Record<string, string | undefined>;
}

export type ResolveSource =
  | "api_url_flag"
  | "env"
  | "name_flag"
  | "cwd_walk"
  | "in_container_default"
  | "default";

export interface ResolvedTarget {
  api_url: string;
  source: ResolveSource;
  /**
   * The registered instance backing the target — populated for every
   * source except `api_url_flag`, `env`, and `in_container_default`,
   * where the CLI has no idea what instance (if any) is on the other
   * end of the URL.
   */
  instance?: Instance;
}

/**
 * Default port the in-container fallback dials. The Dockerfile pins
 * PORT=8062, but we honor whatever `PORT` says at runtime so a custom
 * port mapping doesn't strand the in-container CLI.
 */
const DEFAULT_CONTAINER_PORT = "8062";

/**
 * Precedence (first hit wins):
 *   1. --api-url <url>
 *   2. ARKEON_WIKI_URL env
 *   3. --name <name>
 *   4. CWD walk against registered watch_dirs (deepest match wins)
 *   5. instance named "default"
 *   6. ARKEON_WIKI_IN_CONTAINER=1 → http://127.0.0.1:${PORT}
 *
 * Throws with an actionable error if nothing matches.
 */
export function resolveTarget(opts: ResolveOptions = {}): ResolvedTarget {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  if (opts.apiUrl) {
    return { api_url: opts.apiUrl, source: "api_url_flag" };
  }
  if (env.ARKEON_WIKI_URL) {
    return { api_url: env.ARKEON_WIKI_URL, source: "env" };
  }
  if (opts.name) {
    const inst = findInstance(opts.name);
    if (!inst) {
      throw new Error(
        `No running instance named "${opts.name}". Run \`arkeon-wiki ls\` to see what's running.`,
      );
    }
    return { api_url: inst.api_url, source: "name_flag", instance: inst };
  }
  const owner = findInstanceForCwd(cwd, listInstances());
  if (owner) {
    return { api_url: owner.api_url, source: "cwd_walk", instance: owner };
  }
  const fallback = findInstance(DEFAULT_INSTANCE_NAME);
  if (fallback) {
    return { api_url: fallback.api_url, source: "default", instance: fallback };
  }
  // Last-resort in-container fallback: `docker exec arkeon-wiki
  // arkeon-wiki query` lands in `/`, which sits under no registered
  // watch root, but the daemon is right there on loopback. Tied to
  // ARKEON_WIKI_IN_CONTAINER=1 from the Dockerfile so host CLIs that
  // happen to have neither flag nor running daemon still fail loudly.
  if (env.ARKEON_WIKI_IN_CONTAINER === "1") {
    const port = env.PORT ?? DEFAULT_CONTAINER_PORT;
    return {
      api_url: `http://127.0.0.1:${port}`,
      source: "in_container_default",
    };
  }
  throw new Error(
    `No arkeon-wiki daemon is running, and CWD (${cwd}) is not under any registered watch root. ` +
      `Start one with \`arkeon-wiki up --watch-dir <path>\`, or pass --api-url / --name explicitly.`,
  );
}

/**
 * Pick the instance whose watch_dir contains `cwd`. When multiple
 * instances overlap (a watched root nested inside another), the
 * deepest match wins — that's the answer a user would intuitively
 * expect when standing inside the inner corpus.
 *
 * Instances missing `watch_dir` (registered before that field
 * existed) are skipped silently.
 */
export function findInstanceForCwd(cwd: string, instances: Instance[]): Instance | null {
  const cwdAbs = canonicalize(cwd);
  let best: Instance | null = null;
  let bestLen = -1;
  for (const inst of instances) {
    if (!inst.watch_dir) continue;
    const watchAbs = canonicalize(inst.watch_dir);
    if (isUnder(cwdAbs, watchAbs) && watchAbs.length > bestLen) {
      best = inst;
      bestLen = watchAbs.length;
    }
  }
  return best;
}

/**
 * Compute the watch-root-relative path of `cwd` under an instance's
 * watch_dir. Returns "" when CWD *is* the watch root, and `null` when
 * the instance has no watch_dir or CWD escapes it (defensive — callers
 * should only call this with an instance returned by `findInstanceForCwd`).
 */
export function relativeToWatchDir(cwd: string, instance: Instance): string | null {
  if (!instance.watch_dir) return null;
  const rel = relative(canonicalize(instance.watch_dir), canonicalize(cwd));
  if (rel.startsWith("..")) return null;
  return rel;
}

/** True if `child` equals `parent` or sits beneath it. */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}
