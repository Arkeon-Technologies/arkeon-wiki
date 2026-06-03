// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Running-instance registry.
 *
 * One JSON file per running instance at ~/.arkeon-wiki/instances/<name>.json.
 * The file is written when an instance starts and removed when it stops.
 * Stale entries (pid no longer alive) are pruned on read.
 *
 * The registry path is always under the canonical ~/.arkeon-wiki/, regardless
 * of any per-instance ARKEON_WIKI_HOME override — that way `ls` can see all
 * named instances in one place.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isProcessAlive } from "./local-runtime.js";

export interface Instance {
  name: string;
  api_url: string;
  api_port: number;
  home: string;
  /**
   * Absolute path the daemon is watching. Stored so the CLI can resolve
   * which instance owns the current working directory without spinning
   * up the daemon to ask. May be absent on instances registered before
   * this field existed — readers should treat it as optional.
   */
  watch_dir?: string;
  pid: number;
  started_at: string;
}

export const DEFAULT_INSTANCE_NAME = "default";

function instancesDir(): string {
  return join(homedir(), ".arkeon-wiki", "instances");
}

function instancePath(name: string): string {
  return join(instancesDir(), `${name}.json`);
}

export function registerInstance(instance: Instance): void {
  mkdirSync(instancesDir(), { recursive: true });
  writeFileSync(instancePath(instance.name), `${JSON.stringify(instance, null, 2)}\n`);
}

export function unregisterInstance(name: string): void {
  const path = instancePath(name);
  if (existsSync(path)) rmSync(path);
}

export function findInstance(name: string): Instance | null {
  const path = instancePath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Instance;
  } catch {
    return null;
  }
}

/**
 * Find the instance currently running on a given port, if any. Used by
 * `up` to give a friendlier error when a port collision is caused by
 * another arkeon instance rather than an unrelated service.
 */
export function findInstanceByPort(port: number): Instance | null {
  for (const inst of listInstances()) {
    if (inst.api_port === port) return inst;
  }
  return null;
}

/**
 * List all registered instances. Prunes entries whose pid is no longer alive.
 */
export function listInstances(): Instance[] {
  const dir = instancesDir();
  if (!existsSync(dir)) return [];
  const out: Instance[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    try {
      const inst = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Instance;
      if (isProcessAlive(inst.pid)) {
        out.push(inst);
      } else {
        unregisterInstance(name);
      }
    } catch {
      unregisterInstance(name);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
