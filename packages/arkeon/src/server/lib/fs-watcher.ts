// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Filesystem watcher.
 *
 * Watches the single root directory the daemon was started against
 * and keeps the SQLite index in sync. node:fs.watch with the recursive
 * option (FSEvents on macOS, ReadDirectoryChangesW on Windows) covers
 * the platforms we care about.
 *
 * The watcher's only job is keeping the index live. External harnesses
 * poll the API on whatever schedule they own.
 */

import { watch, type FSWatcher, existsSync, readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

import {
  cleanStaleStaging,
  isIngestable,
  runExtraction,
} from "../extractors/runner.js";
import { syncFile, syncDirectory, removeByPath } from "./sync.js";

// Directories to skip during walk + watch.
const IGNORE_DIRS = new Set([".arkeon", ".git", "node_modules", ".claude", "__pycache__", ".venv"]);

// Eligibility model:
//
//   Most files get indexed. The rule is:
//     - Hidden / ignore-dir paths → skip (.sidecars/ is the one
//       dot-prefixed exception we walk into).
//     - SKIP_EXTENSIONS (secrets, junk, well-known scratch formats) → skip.
//     - Everything else → indexed. Classified as kind='text' or
//       kind='asset' by `classifyFile()`:
//         · TEXT_EXTENSIONS allowlist → fast-path text.
//         · ASSET_EXTENSIONS allowlist → fast-path asset.
//         · Unknown extension → sniff first SNIFF_BYTES; text iff no NUL.
//
// `kind='text'` files feed FTS5 (POST /query with `text`) and have
// their content parsed (HTML extracts `<a class="wikilink">` edges,
// Markdown extracts `[[X]]`). `kind='asset'` files get an artifact
// row with metadata only — no parsing, no link extraction, no FTS5
// entry. They exist so links to binaries resolve as real edges
// instead of redlinks.

// Things we refuse to index at all, regardless of content. Two reasons
// for an extension to be here:
//   (1) it carries secrets (credentials, key material) and indexing
//       would leak it through search / list / read tools;
//   (2) it's local scratch noise that never represents corpus material
//       (OS junk files, editor swap files).
//
// Compare against the prior (deprecated) "binary" denylist: that one
// blocked everything binary-shaped — images, audio, video, PDFs,
// archives — because the agents couldn't read them. Now they can (via
// the fetch tool's image-injection path, plus the planned PDF
// processor), so blocking them at the index level was the wrong layer.
// The list below is only the truly-must-not-index entries.
export const SKIP_EXTENSIONS = new Set([
  // Secret-bearing extensions. These are often text (key=value, PEM,
  // etc.) but the content sniff alone would auto-index them, defeating
  // the purpose of having a "don't watch dotfiles" rule. Literal
  // dotfiles (`.env`, `.envrc`) are also caught by shouldIgnorePath;
  // this set covers the `*.env` suffix case (`production.env`,
  // `staging.env`, etc.) the path-prefix rule misses.
  ".env", ".envrc", ".secret",
  ".pem", ".cer", ".crt", ".der", ".p7b", ".p7c", ".p8",
  ".p12", ".pfx", ".jks", ".keystore", ".truststore",
  ".asc", ".gpg", ".pgp", ".kdbx",
  // Editor / OS scratch noise. Not corpus material, never worth indexing.
  ".swp", ".swo", ".swn",      // vim swap
  ".tmp", ".temp",
  ".bak",                       // generic backup
  ".lock",                      // bundler/yarn/pip lockfile (the *.lock
                                // suffix; package-lock.json etc. are JSON
                                // and stay indexable)
]);

// Junk basenames — never indexed regardless of extension. OS-level
// noise that shows up next to real corpus files.
const SKIP_BASENAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

// Common image / document / media extensions get fast-path classification
// as kind='asset'. Everything not on the text or asset allowlists falls
// through to the content sniff in classifyFile().
export const ASSET_EXTENSIONS = new Set([
  // Documents
  ".pdf", ".epub", ".mobi",
  // Office formats (zip-wrapped XML, not directly text). ".key" here is
  // Apple Keynote — the cryptographic-key sense is covered above in
  // SKIP_EXTENSIONS.
  ".docx", ".doc", ".dotx", ".pptx", ".ppt", ".xlsx", ".xls",
  ".odt", ".ods", ".odp", ".pages", ".numbers", ".key",
  // Images. ".svg" is XML but treated as an asset — it's presentation
  // data, and rendering needs a rasterizer the agent can't drive.
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
]);

export const TEXT_EXTENSIONS = new Set([
  // Authoring / docs
  ".txt", ".html", ".htm", ".md", ".markdown", ".mdx", ".rst", ".tex", ".adoc",
  // Structured data
  ".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".xml",
  // Config
  ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".properties",
  // ".env" / ".envrc" are in SKIP_EXTENSIONS (above) — text content but
  // refused indexing because they're almost always secret-bearing.
  ".editorconfig",
  // Logs / output
  ".log",
  // Source code (callers can read code-as-source)
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
 * Same NUL-byte heuristic as `sniffIsText`, but against an in-memory
 * buffer. Used by the source-write endpoints to gate uploads before
 * they hit disk. Only the first `SNIFF_BYTES` bytes are checked —
 * matches what we'd inspect after the file lands.
 */
export function sniffBufferIsText(buf: Buffer): boolean {
  const limit = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

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

let activeWatcher: FSWatcher | null = null;
let activeWatchedRoot: string | null = null;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const DEBOUNCE_MS = 500;

/**
 * True if any path segment is hidden (`.`-prefixed, except .sidecars)
 * or matches a well-known ignore directory (`.git`, `node_modules`).
 *
 * Exported so the reader routes can return 404 for the same set the
 * watcher refuses to index. Without this, a user could navigate to
 * `/.git/config` and the file-serve fallback would serve it.
 */
export function shouldIgnorePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  for (const part of parts) {
    // .sidecars/ is the v1 sidecar landing zone — sidecars must be
    // indexed (kind='text') so they feed FTS5. Every other dot-prefixed
    // path is skipped (.git, .arkeon, .env, dotfiles in general).
    if (part === ".sidecars") continue;
    if (part.startsWith(".") && part !== ".") return true;
    if (IGNORE_DIRS.has(part)) return true;
  }
  return false;
}

/**
 * Path-only eligibility (no I/O). Drops paths that should never enter
 * the index — hidden / ignore dirs, junk basenames, and known
 * skip-extensions (secrets, editor scratch). Pair with `classifyFile()`
 * to decide kind='text' vs kind='asset' for paths that pass.
 *
 * The old "is it text or binary by extension" decision is no longer
 * here — both texts and assets are indexable now.
 */
export function isPathPotentiallyEligible(relativePath: string): boolean {
  if (shouldIgnorePath(relativePath)) return false;
  const name = basename(relativePath);
  if (SKIP_BASENAMES.has(name)) return false;
  const ext = extname(relativePath).toLowerCase();
  if (ext && SKIP_EXTENSIONS.has(ext)) return false;
  return true;
}

/**
 * Should this file get an entity row at all?
 *
 * Today this is just `isPathPotentiallyEligible` — every file the watcher
 * sees and the path filter accepts becomes an entity (either kind='text'
 * with parsed content or kind='asset' with metadata only). The function
 * is kept as the public eligibility predicate so the routes / scan code
 * has one canonical entry point and we can evolve the rules without
 * threading them through every caller. Operators reading this: yes, this
 * intentionally no longer opens the file — that work moves to
 * `classifyFile`, which the sync path calls once the eligibility gate
 * has passed.
 */
export function isEligibleFile(relativePath: string, _absPath: string): boolean {
  return isPathPotentiallyEligible(relativePath);
}

/**
 * Classify an eligible file as text or asset.
 *
 *   - TEXT_EXTENSIONS allowlist → text (no I/O).
 *   - ASSET_EXTENSIONS allowlist → asset (no I/O).
 *   - Otherwise → sniff the first SNIFF_BYTES; text iff no NUL byte.
 *
 * Callers should gate on `isPathPotentiallyEligible(relativePath)` first;
 * `classifyFile` assumes the path has already passed eligibility.
 *
 * Returns `'asset'` on I/O errors so a momentarily-unreadable file
 * doesn't get mis-parsed as text by `syncFile` (which would then call
 * readFileSync(..., 'utf-8') and corrupt binary data into a UTF-8
 * replacement-character soup). Asset-mode reads only metadata, which is
 * the safe fallback.
 */
export function classifyFile(
  relativePath: string,
  absPath: string,
): "text" | "asset" {
  const ext = extname(relativePath).toLowerCase();
  if (ext && TEXT_EXTENSIONS.has(ext)) return "text";
  if (ext && ASSET_EXTENSIONS.has(ext)) return "asset";
  return sniffIsText(absPath) ? "text" : "asset";
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
    // .sidecars/ is the only dot-prefixed dir we walk into; everything
    // else dotfile is skipped.
    if (entry.name.startsWith(".") && entry.name !== ".sidecars") continue;

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
 * Start watching the daemon's single root.
 *
 * First runs a full reconciliation (walk + syncDirectory), then starts
 * a live watcher for incremental changes.
 */
export async function startWatching(watchedRoot: string): Promise<void> {
  if (activeWatcher) {
    console.log(`[watcher] Already watching ${activeWatchedRoot}`);
    return;
  }

  if (!existsSync(watchedRoot)) {
    console.warn(`[watcher] Directory not found: ${watchedRoot}`);
    return;
  }

  console.log(`[watcher] Reconciling ${watchedRoot}`);
  cleanStaleStaging(watchedRoot);
  const files = walkEligibleFiles(watchedRoot);
  const summary = await syncDirectory(watchedRoot, files);
  console.log(
    `[watcher] Reconciled: ${summary.created} created, ${summary.updated} updated, ` +
      `${summary.unchanged} unchanged, ${summary.removed} removed`,
  );

  for (const relPath of files) {
    if (isIngestable(relPath)) {
      runExtraction({ watchedRoot, relativePath: relPath }).catch((err) => {
        console.error(
          `[ingest] bootstrap extraction failed for ${relPath}:`,
          (err as Error).message,
        );
      });
    }
  }

  try {
    const watcher = watch(watchedRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      const relativePath = filename.replace(/\\/g, "/");
      if (!isPathPotentiallyEligible(relativePath)) return;

      const absPath = join(watchedRoot, relativePath);
      const existing = debounceTimers.get(absPath);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        absPath,
        setTimeout(() => {
          debounceTimers.delete(absPath);
          handleFileEvent(watchedRoot, relativePath);
        }, DEBOUNCE_MS),
      );
    });

    watcher.on("error", (err) => {
      console.error(`[watcher] Error in ${watchedRoot}:`, err.message);
    });

    activeWatcher = watcher;
    activeWatchedRoot = watchedRoot;
    console.log(`[watcher] Watching ${watchedRoot} (${files.length} files)`);
  } catch (err) {
    console.error(`[watcher] Failed to start watching ${watchedRoot}:`, (err as Error).message);
  }
}

async function handleFileEvent(watchedRoot: string, relativePath: string): Promise<void> {
  const absPath = join(watchedRoot, relativePath);

  if (existsSync(absPath)) {
    try {
      if (statSync(absPath).isDirectory()) return;
    } catch {
      return;
    }
    if (!isEligibleFile(relativePath, absPath)) return;
    try {
      const result = await syncFile(watchedRoot, relativePath);
      if (result.action !== "unchanged") {
        console.log(`[watcher] ${result.action}: ${result.label} (${relativePath})`);
      }
      if (
        result.action !== "unchanged" &&
        result.kind === "asset" &&
        isIngestable(relativePath)
      ) {
        runExtraction({ watchedRoot, relativePath }).catch((err) => {
          console.error(
            `[ingest] extraction failed for ${relativePath}:`,
            (err as Error).message,
          );
        });
      }
    } catch (err) {
      console.error(`[watcher] Error syncing ${relativePath}:`, (err as Error).message);
    }
  } else {
    try {
      const removed = await removeByPath(relativePath);
      if (removed) {
        console.log(`[watcher] removed: ${relativePath}`);
      }
    } catch (err) {
      console.error(`[watcher] Error removing ${relativePath}:`, (err as Error).message);
    }
  }
}

export async function stopWatching(): Promise<void> {
  if (activeWatcher) {
    activeWatcher.close();
    activeWatcher = null;
    activeWatchedRoot = null;
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

export function getWatchedRoot(): string | null {
  return activeWatchedRoot;
}
