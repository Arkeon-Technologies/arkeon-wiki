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

import { watch, type FSWatcher, existsSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname } from "node:path";

import { startScheduler } from "../agents/scheduler.js";
import { syncFile, syncDirectory, removeByPath, type Space } from "./sync.js";

type SchedulerHandle = Awaited<ReturnType<typeof startScheduler>>;

// Directories to skip during walk + watch.
const IGNORE_DIRS = new Set([".arkeon", ".git", "node_modules", ".claude", "__pycache__", ".venv"]);

// Eligibility decision is three-tier:
//
//   1. BINARY_EXTENSIONS — known-binary, never indexed (fast reject, no I/O).
//   2. TEXT_EXTENSIONS — known-text, indexed without inspection (fast accept).
//   3. Everything else — open the file, read the first SNIFF_BYTES, treat as
//      text iff there's no NUL byte. Same rule `git`, `grep -I`, and `file(1)`
//      use to decide "text vs binary."
//
// This lets the agents reach files with unfamiliar extensions (custom configs,
// random source code, README/LICENSE with no extension) without us having to
// chase an ever-growing allowlist.

// "BINARY" here is a slight misnomer — the set is "extensions we refuse
// to index, regardless of content." Most entries are literal binary
// formats; a few (".svg", ".env", credentials) are text but excluded for
// reasons noted inline.
export const BINARY_EXTENSIONS = new Set([
  // Documents
  ".pdf", ".epub", ".mobi",
  // Office formats (zip-wrapped XML, not directly text). ".key" here is
  // Apple Keynote; the cryptographic-key sense is covered in the
  // credentials block below.
  ".docx", ".doc", ".dotx", ".pptx", ".ppt", ".xlsx", ".xls",
  ".odt", ".ods", ".odp", ".pages", ".numbers", ".key",
  // Images. ".svg" is technically text (XML) but treated as binary: its
  // bytes are presentation data, not corpus material the agents would
  // benefit from indexing.
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
  ".tiff", ".tif", ".heic", ".heif", ".avif", ".raw",
  // Audio / video
  ".mp3", ".mp4", ".webm", ".mov", ".wav", ".flac", ".ogg", ".oga",
  ".m4a", ".m4v", ".avi", ".wmv", ".mkv", ".aac", ".opus",
  // Archives
  ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".lz", ".zst",
  // Binaries / native code
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".bin", ".class", ".jar", ".war",
  ".wasm", ".obj",
  // Fonts
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // Databases / compiled
  ".db", ".sqlite", ".sqlite3", ".mdb", ".pyc", ".pyo",
  // Disk images / installers
  ".dmg", ".iso", ".pkg", ".deb", ".rpm", ".msi", ".apk", ".ipa",
  // Secret-bearing extensions. These are usually text (key=value, PEM,
  // etc.) but the sniff alone would auto-index them, defeating the
  // purpose of having a "don't watch dotfiles" rule. Listing them here
  // makes rejection explicit and content-independent. Literal dotfiles
  // (`.env`, `.envrc`) are also caught by shouldIgnorePath; this set
  // covers the `*.env` suffix case (`production.env`, `staging.env`,
  // etc.) the path-prefix rule misses.
  ".env", ".envrc", ".secret",
  ".pem", ".cer", ".crt", ".der", ".p7b", ".p7c", ".p8",
  ".p12", ".pfx", ".jks", ".keystore", ".truststore",
  ".asc", ".gpg", ".pgp", ".kdbx",
]);

export const TEXT_EXTENSIONS = new Set([
  // Authoring / docs
  ".txt", ".html", ".htm", ".md", ".markdown", ".mdx", ".rst", ".tex", ".adoc",
  // Structured data
  ".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".xml",
  // Config
  ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".properties",
  // ".env" / ".envrc" are in BINARY_EXTENSIONS (above) — text content but
  // refused indexing because they're almost always secret-bearing.
  ".editorconfig",
  // Logs / output
  ".log",
  // Source code (agents can read code-as-source)
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".sql", ".graphql", ".gql",
  ".css", ".scss", ".sass", ".less",
  ".lua", ".php", ".pl", ".r", ".jl", ".scala", ".clj", ".cljs", ".ex", ".exs", ".erl",
]);

const SNIFF_BYTES = 8192;

/**
 * Read the first SNIFF_BYTES of `absPath` and decide text-vs-binary
 * by looking for NUL bytes. Same heuristic as `git`, `grep -I`,
 * and `file(1)`. Returns false on any I/O error (the file is then
 * not eligible — same outcome as truly-binary).
 *
 * Empty files have zero NULs and are reported as text. That's the
 * right default: an empty `README` is text we'd want indexed once
 * the user fills it in, and `syncFile()` handles empty bodies fine.
 */
export function sniffIsText(absPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(absPath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const bytesRead = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

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

/**
 * Path-only eligibility (no I/O). Use to gate watcher events cheaply:
 * rejects hidden dirs and known-binary extensions, lets anything else
 * through. Pair with `isEligibleFile()` (which adds the content sniff)
 * before actually indexing.
 */
export function isPathPotentiallyEligible(relativePath: string): boolean {
  if (shouldIgnorePath(relativePath)) return false;
  const ext = extname(relativePath).toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) return false;
  return true;
}

/**
 * Full eligibility — applies the three-tier check. May open the file
 * for sniffing if the extension is unknown.
 */
export function isEligibleFile(relativePath: string, absPath: string): boolean {
  if (!isPathPotentiallyEligible(relativePath)) return false;
  const ext = extname(relativePath).toLowerCase();
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  return sniffIsText(absPath);
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
      const absPath = join(root, relativePath);
      if (isEligibleFile(relativePath, absPath)) {
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
      // Cheap pre-filter: drops hidden / ignored paths and known-binary
      // extensions without I/O. The content sniff for unknown extensions
      // happens inside handleFileEvent before syncFile, so deletes (where
      // sniffing isn't possible) still flow through.
      if (!isPathPotentiallyEligible(relativePath)) return;

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
    // Full eligibility (may sniff content). A file that passes the
    // path-only pre-filter but turns out to be binary on inspection
    // gets dropped here — not indexed.
    if (!isEligibleFile(relativePath, absPath)) return;
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
