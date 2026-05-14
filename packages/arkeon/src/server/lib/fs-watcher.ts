// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Filesystem watcher.
 *
 * Watches registered space directories for changes and keeps the
 * SQLite mirror in sync. node:fs.watch with the recursive option
 * (FSEvents on macOS, ReadDirectoryChangesW on Windows) covers the
 * platforms we care about.
 *
 * The watcher's only job is keeping the index live. Agents are
 * cron-paced — they query entities directly on each tick.
 */

import { watch, type FSWatcher, existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

import { startScheduler } from "../agents/scheduler.js";
import { syncFile, syncDirectory, removeByPath, type Space } from "./sync.js";

type SchedulerHandle = Awaited<ReturnType<typeof startScheduler>>;

// Directories to skip during walk + watch.
const IGNORE_DIRS = new Set([".arkeon", ".git", "node_modules", ".claude", "__pycache__", ".venv"]);

// File extensions we index. Anything else is invisible to the system.
// Exported so callers like the sources-scan endpoint can partition a
// directory listing against the same set the watcher applies — keeps
// "what's indexable" defined in exactly one place.
export const INDEX_EXTENSIONS = new Set([".txt", ".json", ".csv", ".xml", ".html", ".rst"]);

const watchers = new Map<string, FSWatcher>();
const schedulers = new Map<string, SchedulerHandle>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const DEBOUNCE_MS = 500;

/**
 * True if any path segment is hidden (`.`-prefixed) or matches a
 * well-known ignore directory (`.git`, `node_modules`, `.arkeon`, etc.).
 *
 * Exported so the reader routes can return 404 for the same set the
 * watcher refuses to index — keeping one rule in one place. Without
 * this, a user could navigate to `/{space}/.arkeon/state.json` or
 * `/{space}/.git/config` and the static-file fallback would serve it.
 */
export function shouldIgnorePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  for (const part of parts) {
    if (part.startsWith(".") && part !== ".") return true;
    if (IGNORE_DIRS.has(part)) return true;
  }
  return false;
}

function isEligibleFile(relativePath: string): boolean {
  if (shouldIgnorePath(relativePath)) return false;
  const ext = extname(relativePath).toLowerCase();
  return INDEX_EXTENSIONS.has(ext);
}

/**
 * Walk a directory tree and return all eligible file paths
 * (space-relative).
 */
export function walkEligibleFiles(root: string, prefix = ""): string[] {
  const results: string[] = [];

  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      results.push(...walkEligibleFiles(root, relativePath));
    } else if (entry.isFile()) {
      if (isEligibleFile(relativePath)) {
        results.push(relativePath);
      }
    }
  }

  return results;
}

/**
 * Start watching a space directory.
 *
 * First runs a full reconciliation (walk + syncDirectory), then starts
 * a live watcher for incremental changes.
 */
export async function startWatching(space: Space): Promise<void> {
  if (watchers.has(space.name)) {
    console.log(`[watcher] Already watching space ${space.name}`);
    return;
  }

  if (!existsSync(space.watch_dir)) {
    console.warn(`[watcher] Directory not found: ${space.watch_dir} — skipping space ${space.name}`);
    return;
  }

  console.log(`[watcher] Reconciling space "${space.name}" (${space.watch_dir})`);
  const files = walkEligibleFiles(space.watch_dir);
  const summary = await syncDirectory(space, files);
  console.log(
    `[watcher] Reconciled: ${summary.created} created, ${summary.updated} updated, ` +
      `${summary.unchanged} unchanged, ${summary.removed} removed`,
  );

  try {
    const scheduler = await startScheduler({ space });
    schedulers.set(space.name, scheduler);
  } catch (err) {
    console.error(
      `[watcher] Failed to start agent scheduler for space "${space.name}":`,
      (err as Error).message,
    );
  }

  try {
    const watcher = watch(space.watch_dir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      const relativePath = filename.replace(/\\/g, "/");
      if (!isEligibleFile(relativePath)) return;

      const absPath = join(space.watch_dir, relativePath);
      const existing = debounceTimers.get(absPath);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        absPath,
        setTimeout(() => {
          debounceTimers.delete(absPath);
          handleFileEvent(space, relativePath);
        }, DEBOUNCE_MS),
      );
    });

    watcher.on("error", (err) => {
      console.error(`[watcher] Error in space "${space.name}":`, err.message);
    });

    watchers.set(space.name, watcher);
    console.log(`[watcher] Watching space "${space.name}" (${files.length} files)`);
  } catch (err) {
    console.error(`[watcher] Failed to start watching space "${space.name}":`, (err as Error).message);
  }
}

async function handleFileEvent(space: Space, relativePath: string): Promise<void> {
  const absPath = join(space.watch_dir, relativePath);

  if (existsSync(absPath)) {
    try {
      const result = await syncFile(space, relativePath);
      if (result.action !== "unchanged") {
        console.log(`[watcher] ${result.action}: ${result.label} (${relativePath})`);
      }
    } catch (err) {
      console.error(`[watcher] Error syncing ${relativePath}:`, (err as Error).message);
    }
  } else {
    try {
      const removed = await removeByPath(space, relativePath);
      if (removed) {
        console.log(`[watcher] removed: ${relativePath}`);
      }
    } catch (err) {
      console.error(`[watcher] Error removing ${relativePath}:`, (err as Error).message);
    }
  }
}

export async function stopWatching(spaceName: string): Promise<void> {
  const watcher = watchers.get(spaceName);
  if (watcher) {
    watcher.close();
    watchers.delete(spaceName);
  }
  const scheduler = schedulers.get(spaceName);
  if (scheduler) {
    await scheduler.stop();
    schedulers.delete(spaceName);
  }
}

export async function stopAllWatchers(): Promise<void> {
  for (const [name, watcher] of watchers) {
    watcher.close();
    watchers.delete(name);
  }
  for (const [name, scheduler] of schedulers) {
    await scheduler.stop();
    schedulers.delete(name);
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

export async function startAllWatchers(): Promise<void> {
  const { createSql } = await import("./sql.js");
  const sql = createSql();
  const spaces = await sql`
    SELECT name, watch_dir FROM spaces WHERE watch_dir IS NOT NULL
  `;

  for (const space of spaces) {
    await startWatching(space as unknown as Space);
  }
}
