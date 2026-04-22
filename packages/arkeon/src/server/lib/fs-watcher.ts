// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Filesystem watcher for automatic sync.
 *
 * Watches registered space directories for changes and automatically
 * syncs files to Postgres. Uses node:fs.watch with recursive option
 * (FSEvents on macOS, ReadDirectoryChangesW on Windows).
 */

import { watch, type FSWatcher, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

import { syncFile, syncDirectory, removeByPath, type Space } from "./sync.js";

// Directories to ignore when watching/walking
const IGNORE_DIRS = new Set([".arkeon", ".git", "node_modules", ".claude", "__pycache__", ".venv"]);

// File extensions to index
const INDEX_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".xml", ".html", ".rst"]);

// Active watchers keyed by space ID
const watchers = new Map<string, FSWatcher>();

// Debounce timers keyed by absolute file path
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const DEBOUNCE_MS = 500;

function shouldIgnorePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  // Ignore dotfiles and ignored directories
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
 * Walk a directory tree and return all eligible file paths (space-relative).
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
  if (watchers.has(space.id)) {
    console.log(`[watcher] Already watching space ${space.name}`);
    return;
  }

  if (!existsSync(space.watch_dir)) {
    console.warn(`[watcher] Directory not found: ${space.watch_dir} — skipping space ${space.name}`);
    return;
  }

  // Reconcile: walk the directory and sync all eligible files
  console.log(`[watcher] Reconciling space "${space.name}" (${space.watch_dir})`);
  const files = walkEligibleFiles(space.watch_dir);
  const summary = await syncDirectory(space, files);
  console.log(
    `[watcher] Reconciled: ${summary.created} created, ${summary.updated} updated, ` +
    `${summary.unchanged} unchanged, ${summary.removed} removed`,
  );

  // Start the live watcher
  try {
    const watcher = watch(space.watch_dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Normalize path separators (Windows)
      const relativePath = filename.replace(/\\/g, "/");

      if (!isEligibleFile(relativePath)) return;

      // Debounce: coalesce rapid events (editor save → temp write → rename)
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

    watchers.set(space.id, watcher);
    console.log(`[watcher] Watching space "${space.name}" (${files.length} files)`);
  } catch (err) {
    console.error(`[watcher] Failed to start watching space "${space.name}":`, (err as Error).message);
  }
}

async function handleFileEvent(space: Space, relativePath: string): Promise<void> {
  const absPath = join(space.watch_dir, relativePath);

  if (existsSync(absPath)) {
    // File added or modified
    try {
      const result = await syncFile(space, relativePath);
      if (result.action !== "unchanged") {
        console.log(`[watcher] ${result.action}: ${result.label} (${relativePath})`);
      }
    } catch (err) {
      console.error(`[watcher] Error syncing ${relativePath}:`, (err as Error).message);
    }
  } else {
    // File deleted
    try {
      const removedId = await removeByPath(space.id, relativePath);
      if (removedId) {
        console.log(`[watcher] removed: ${relativePath}`);
      }
    } catch (err) {
      console.error(`[watcher] Error removing ${relativePath}:`, (err as Error).message);
    }
  }
}

/**
 * Stop watching a space.
 */
export function stopWatching(spaceId: string): void {
  const watcher = watchers.get(spaceId);
  if (watcher) {
    watcher.close();
    watchers.delete(spaceId);
  }
}

/**
 * Stop all watchers.
 */
export function stopAllWatchers(): void {
  for (const [id, watcher] of watchers) {
    watcher.close();
    watchers.delete(id);
  }
  // Clear any pending debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

/**
 * Start watchers for all registered spaces.
 * Called on server startup.
 */
export async function startAllWatchers(): Promise<void> {
  const { createSql } = await import("./sql.js");
  const sql = createSql();
  const spaces = await sql`
    SELECT id, name, watch_dir FROM spaces WHERE watch_dir IS NOT NULL
  `;

  for (const space of spaces) {
    await startWatching(space as unknown as Space);
  }
}
