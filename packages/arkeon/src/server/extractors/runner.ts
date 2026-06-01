// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extractor orchestration: stage assets in a tmp dir, invoke the
 * handler, validate output, atomically swap into place, write the
 * sidecar, sync it through the normal pipeline, and tag the result so
 * re-extraction skips already-processed sidecars.
 *
 * Failure paths produce a stub sidecar with the error inline — the
 * editor still sees a real source rather than nothing, and the failure
 * is visible at the next read.
 *
 * Per-binary serialization: the extractor pipeline runs under
 * `withPathLock(spaceName::relPath)` so rapid edits coalesce and we
 * never have two subprocesses staging into the same assets dir.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { deleteTag, getArtifact, setTag } from "../lib/entities.js";
import { removeByPath, syncFile } from "../lib/sync.js";

import { requireAdaptersManifest } from "./adapters.js";
import { handlerFor, INGESTABLE_EXTENSIONS } from "./index.js";
import type { FileHandler } from "./types.js";
import {
  buildStubSidecar,
  InvalidExtractedHtmlError,
  validateExtractedHtml,
} from "./validate.js";

/**
 * Per-binary serialization: if two events fire for the same path back to
 * back, we don't want two subprocesses staging into the same assets dir.
 * Queue them on a Map of in-flight Promises keyed by space::path.
 */
const inFlight = new Map<string, Promise<unknown>>();

function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = inFlight.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  inFlight.set(
    key,
    next.finally(() => {
      if (inFlight.get(key) === next) inFlight.delete(key);
    }),
  );
  return next;
}

/** Sidecar carries this tag set after a successful extraction. */
const EXTRACTED_BY_TAG = "extracted_by";

/** Tagged value distinguishing failed sidecars from successful ones. */
const EXTRACTED_BY_FAILED = "failed";

/**
 * When a sidecar is "failed", we also stamp the binary's source_hash
 * at the time of failure. The skip rule short-circuits re-extraction
 * only when the binary's CURRENT hash matches — i.e., we already
 * failed on this exact content. If the binary changes, the hashes
 * differ and we retry.
 *
 * Without this, every watcher restart re-runs the failing extractor
 * forever (retry-on-every-restart instead of retry-on-content-change).
 */
const FAILED_FOR_BINARY_HASH_TAG = "failed_for_binary_hash";

export interface RunExtractionOptions {
  watchedRoot: string;
  /** Relative path to the binary that landed on disk. */
  relativePath: string;
}

export type ExtractionOutcome =
  | { status: "extracted"; sidecarPath: string; extractedBy: string; assetCount: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; sidecarPath: string; error: string };

export function isIngestable(relativePath: string): boolean {
  return handlerFor(relativePath) !== null;
}

export { INGESTABLE_EXTENSIONS };

/**
 * Drive the full extraction pipeline for a single binary. Public entry
 * point used by the watcher.
 */
export async function runExtraction(
  opts: RunExtractionOptions,
): Promise<ExtractionOutcome | null> {
  const handler = handlerFor(opts.relativePath);
  if (!handler) return null;

  return withPathLock(`extract::${opts.relativePath}`, () =>
    runExtractionInner(opts, handler),
  );
}

async function runExtractionInner(
  opts: RunExtractionOptions,
  handler: FileHandler,
): Promise<ExtractionOutcome> {
  const { watchedRoot, relativePath } = opts;
  const absPath = join(watchedRoot, relativePath);
  const sidecarRelPath = `${relativePath}.html`;
  const sidecarAbsPath = join(watchedRoot, sidecarRelPath);
  // assetsRelDir is the dir basename only — that's what the script
  // embeds in <img src> paths (sidecar lives in the same parent dir).
  const assetsRelDir = `${baseName(relativePath)}.assets`;
  const assetsAbsDir = join(dirname(absPath), assetsRelDir);
  // assetsSpaceRelDir is the space-relative path used for syncFile —
  // e.g. "sources/papers/paper.pdf.assets".
  const binaryParentRel = dirname(relativePath);
  const assetsSpaceRelDir =
    binaryParentRel === "." ? assetsRelDir : `${binaryParentRel}/${assetsRelDir}`;

  // Re-extraction skip: if an existing sidecar was authored by hand
  // (no extracted_by tag) or explicitly tagged "manual", leave it
  // alone. Users can force re-extraction by deleting the sidecar.
  const skipReason = await shouldSkipExisting(relativePath, sidecarRelPath);
  if (skipReason) {
    return { status: "skipped", reason: skipReason };
  }

  // The watcher should have caught this and we wouldn't have been
  // dispatched, but defend anyway — if the binary vanished mid-run,
  // there's nothing to extract from.
  if (!existsSync(absPath)) {
    return { status: "skipped", reason: "binary disappeared before extraction" };
  }

  let stagingDir: string | null = null;
  try {
    const adapters = requireAdaptersManifest();

    stagingDir = createStagingDir(absPath);

    const log = (level: "info" | "warn" | "error", msg: string): void => {
      // Daemon log line — same shape as the watcher's so they're
      // easy to grep together.
      const prefix = `[ingest/${handler.name}]`;
      const fn =
        level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`${prefix} ${msg}`);
    };

    const ctrl = new AbortController();
    log("info", `${relativePath} → extracting`);

    const result = await handler.extract({
      absPath,
      relativePath,
      adapters,
      assetsDir: stagingDir,
      assetsRelDir,
      signal: ctrl.signal,
      log,
    });

    validateExtractedHtml(result.html);

    // Atomic swap: stage → final. Remove any pre-existing assets dir
    // first so the rename has a clean landing spot. Both the rmSync
    // and the rename are local fs ops; failure leaves the staging
    // dir in place which the next run will collide-cleanup.
    if (existsSync(assetsAbsDir)) {
      // Also remove the corresponding asset entity rows so the index
      // doesn't accumulate stale `paper.pdf.assets/page-N.png` rows
      // pointing at the prior extraction's files.
      for (const stale of readdirSync(assetsAbsDir)) {
        try {
          await removeByPath(`${assetsSpaceRelDir}/${stale}`);
        } catch {
          /* ignore — best-effort cleanup */
        }
      }
      rmSync(assetsAbsDir, { recursive: true, force: true });
    }
    renameSync(stagingDir, assetsAbsDir);
    stagingDir = null;

    // The atomic rename moves files INTO the watched tree as a single
    // directory operation. fs.watch (FSEvents on macOS, inotify on
    // Linux) doesn't reliably fire per-file events for files inside a
    // renamed directory, so the watcher would never index our assets.
    // Sync them explicitly here — same code path the watcher uses for
    // any normal file landing.
    for (const assetName of readdirSync(assetsAbsDir)) {
      const assetSpaceRelPath = `${assetsSpaceRelDir}/${assetName}`;
      try {
        await syncFile(watchedRoot, assetSpaceRelPath);
      } catch (err) {
        log(
          "warn",
          `failed to sync asset ${assetSpaceRelPath}: ${(err as Error).message}`,
        );
      }
    }

    writeSidecarAtomic(sidecarAbsPath, result.html);
    await syncFile(watchedRoot, sidecarRelPath);

    // Tag the sidecar so re-extraction skips manual overrides.
    await setTag(sidecarRelPath, EXTRACTED_BY_TAG, result.extractedBy);
    await deleteTag(sidecarRelPath, FAILED_FOR_BINARY_HASH_TAG);

    const assets = readdirSync(assetsAbsDir);
    log(
      "info",
      `${relativePath} → ${sidecarRelPath} + ${assets.length} asset(s) (${result.extractedBy})`,
    );
    if (result.warnings && result.warnings.length > 0) {
      log("warn", `${relativePath}: ${result.warnings.length} warning(s) from extractor`);
    }

    return {
      status: "extracted",
      sidecarPath: sidecarRelPath,
      extractedBy: result.extractedBy,
      assetCount: assets.length,
    };
  } catch (err) {
    // Best-effort cleanup of the staging dir before writing the stub.
    if (stagingDir && existsSync(stagingDir)) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // ignore — leave the orphan; next run cleans it up
      }
    }

    const errorMessage = err instanceof Error ? err.message : String(err);
    const stubHtml = buildStubSidecar({
      binaryRelPath: relativePath,
      handlerName: handler.name,
      error:
        err instanceof InvalidExtractedHtmlError
          ? `Extractor output failed validation: ${errorMessage}`
          : errorMessage,
    });

    try {
      writeSidecarAtomic(sidecarAbsPath, stubHtml);
      await syncFile(watchedRoot, sidecarRelPath);
      await setTag(sidecarRelPath, EXTRACTED_BY_TAG, EXTRACTED_BY_FAILED);
      const binary = await getArtifact(relativePath);
      if (binary?.source_hash) {
        await setTag(sidecarRelPath, FAILED_FOR_BINARY_HASH_TAG, binary.source_hash);
      }
    } catch (stubErr) {
      console.error(
        `[ingest/${handler.name}] failed to write stub sidecar for ${relativePath}: ${(stubErr as Error).message}`,
      );
    }

    console.error(`[ingest/${handler.name}] ${relativePath}: ${errorMessage}`);
    return { status: "failed", sidecarPath: sidecarRelPath, error: errorMessage };
  }
}

/**
 * Check the existing sidecar (if any) and decide whether to skip
 * re-extraction. Returns a human-readable reason on skip, or null
 * to proceed.
 *
 * Rules:
 * - No sidecar entity yet → proceed (first extraction).
 * - Sidecar has extracted_by = "manual" → skip (user took it over).
 * - Sidecar exists but no extracted_by tag → skip (user authored it
 *   before the extractor existed for this format).
 * - Sidecar has extracted_by = "failed" AND failed_for_binary_hash
 *   matches the binary's current source_hash → skip (we already
 *   failed on this exact content; retry only on content change).
 * - Sidecar has any other extracted_by → proceed (re-extract; either
 *   the content changed or we want a fresh run).
 */
async function shouldSkipExisting(
  binaryRelPath: string,
  sidecarRelPath: string,
): Promise<string | null> {
  const entity = await getArtifact(sidecarRelPath);
  if (!entity) return null;

  const extractedBy = entity.tags[EXTRACTED_BY_TAG];

  if (extractedBy === undefined || extractedBy === null) {
    return "sidecar exists without extracted_by tag (treated as manual)";
  }
  const extractedByStr = extractedBy.toLowerCase();
  if (extractedByStr === "manual") {
    return "sidecar tagged extracted_by=manual";
  }
  if (extractedByStr === EXTRACTED_BY_FAILED) {
    const failedFor = entity.tags[FAILED_FOR_BINARY_HASH_TAG];
    if (typeof failedFor !== "string" || failedFor.length === 0) {
      return null;
    }
    const binary = await getArtifact(binaryRelPath);
    if (binary && binary.source_hash === failedFor) {
      return "sidecar previously failed on this content (extracted_by=failed)";
    }
    return null;
  }
  return null;
}

function baseName(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx >= 0 ? relativePath.slice(idx + 1) : relativePath;
}

function createStagingDir(binaryAbsPath: string): string {
  const parent = dirname(binaryAbsPath);
  // Random suffix so concurrent runs (which shouldn't happen due to
  // path-lock, but defense in depth) don't collide.
  const suffix = randomBytes(6).toString("hex");
  const dir = join(parent, `.arkeon-ingest.${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write `content` to `targetAbsPath` via tmp + rename so the watcher
 * never sees a half-written sidecar.
 */
function writeSidecarAtomic(targetAbsPath: string, content: string): void {
  const tmpPath = `${targetAbsPath}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, content, "utf-8");
  try {
    renameSync(tmpPath, targetAbsPath);
  } catch (err) {
    // Best-effort cleanup if rename failed (e.g. cross-device).
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Sweep `.arkeon-ingest.*` staging directories that survived a crash.
 * Called once per space at startWatching time. Pure best-effort —
 * failures are logged but never fatal.
 */
export function cleanStaleStaging(watchDir: string): void {
  try {
    walkAndCleanStaging(watchDir);
  } catch (err) {
    console.warn(
      `[ingest] stale-staging sweep failed for ${watchDir}: ${(err as Error).message}`,
    );
  }
}

function walkAndCleanStaging(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..") {
      if (entry.isDirectory() && entry.name.startsWith(".arkeon-ingest.")) {
        const abs = join(dir, entry.name);
        try {
          // Don't nuke a staging dir that's actively being written.
          // Heuristic: untouched for >5 min.
          const stat = statSync(abs);
          if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
            rmSync(abs, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
      }
      // Skip recursing into other hidden dirs (.git etc.)
      continue;
    }
    if (entry.isDirectory()) {
      walkAndCleanStaging(join(dir, entry.name));
    }
  }
}
