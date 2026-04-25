// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * .arkeon/state.json reader/writer.
 *
 * Binds a directory to an Arkeon space. Safe to commit — no secrets.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type RepoState = {
  api_url: string;
  space_id: string;
  space_name: string;
  created_at: string;
};

const STATE_DIR = ".arkeon";
const STATE_FILE = "state.json";

let cachedState: RepoState | null | undefined;

function findStateDir(from: string): string | null {
  let dir = resolve(from);
  const root = dirname(dir);
  while (dir !== root) {
    const candidate = join(dir, STATE_DIR, STATE_FILE);
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (existsSync(join(dir, STATE_DIR, STATE_FILE))) {
    return dir;
  }
  return null;
}

export function loadRepoState(cwd?: string): RepoState | null {
  if (!cwd && cachedState !== undefined) return cachedState;

  const base = findStateDir(cwd ?? process.cwd());
  if (!base) {
    if (!cwd) cachedState = null;
    return null;
  }
  try {
    const raw = readFileSync(join(base, STATE_DIR, STATE_FILE), "utf-8");
    const state = JSON.parse(raw) as RepoState;
    if (!cwd) cachedState = state;
    return state;
  } catch {
    if (!cwd) cachedState = null;
    return null;
  }
}

export function saveRepoState(state: RepoState, cwd?: string): void {
  const base = cwd ?? process.cwd();
  const dir = join(base, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
  if (!cwd) cachedState = state;
}
