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

import { getEntity, setEntityTag } from "../lib/entities.js";
import { setEditContext, clearEditContext } from "../lib/edit-context.js";
import { withPathLock } from "../lib/path-lock.js";
import { removeByPath, syncFile, type Space } from "../lib/sync.js";

import { requireAdaptersManifest } from "./adapters.js";
import { handlerFor, INGESTABLE_EXTENSIONS } from "./index.js";
import type { FileHandler } from "./types.js";
import {
  buildStubSidecar,
  InvalidExtractedHtmlError,
  validateExtractedHtml,
} from "./validate.js";

/**
 * The "by_role" attribution stamped onto entity_edits rows produced by
 * the extractor's sidecar writes. Distinct from "human" (filesystem
 * edits) and the agent role names so the recent feed can filter to
 * "what the extractor produced lately".
 */
const INGEST_BY_ROLE = "ingest";

/** Sidecar carries this tag set after a successful extraction. */
const EXTRACTED_BY_TAG = "extracted_by";

/** Tagged value distinguishing failed sidecars from successful ones. */
const EXTRACTED_BY_FAILED = "failed";

export interface RunExtractionOptions {
  space: Space;
  /** Space-relative path to the binary that landed on disk. */
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

  return withPathLock(`extract::${opts.space.name}::${opts.relativePath}`, () =>
    runExtractionInner(opts, handler),
  );
}

async function runExtractionInner(
  opts: RunExtractionOptions,
  handler: FileHandler,
): Promise<ExtractionOutcome> {
  const { space, relativePath } = opts;
  const absPath = join(space.watch_dir, relativePath);
  const sidecarRelPath = `${relativePath}.html`;
  const sidecarAbsPath = join(space.watch_dir, sidecarRelPath);
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
  const skipReason = await shouldSkipExisting(space, sidecarRelPath);
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
      spaceName: space.name,
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
          await removeByPath(space, `${assetsSpaceRelDir}/${stale}`);
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
        await syncFile(space, assetSpaceRelPath);
      } catch (err) {
        log(
          "warn",
          `failed to sync asset ${assetSpaceRelPath}: ${(err as Error).message}`,
        );
      }
    }

    // Write sidecar with edit attribution so the entity_edits row
    // records by_role='ingest' instead of the default 'human'. We use
    // "resync" when the sidecar already existed (overwriting our own
    // previous extraction) and "create" for the first run.
    const sidecarPreexisted = existsSync(sidecarAbsPath);
    writeSidecarAtomic(sidecarAbsPath, result.html);
    setEditContext(space.name, sidecarRelPath, {
      role: INGEST_BY_ROLE,
      edit_kind: sidecarPreexisted ? "resync" : "create",
      note: `${handler.name} sidecar`,
    });
    try {
      await syncFile(space, sidecarRelPath);
    } finally {
      clearEditContext(space.name, sidecarRelPath);
    }

    // Tag the sidecar so re-extraction skips manual overrides and so
    // we can identify failed vs. successful sidecars later.
    await setEntityTag(
      space.name,
      sidecarRelPath,
      EXTRACTED_BY_TAG,
      result.extractedBy,
    );

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
      const sidecarPreexisted = existsSync(sidecarAbsPath);
      writeSidecarAtomic(sidecarAbsPath, stubHtml);
      setEditContext(space.name, sidecarRelPath, {
        role: INGEST_BY_ROLE,
        edit_kind: sidecarPreexisted ? "resync" : "create",
        note: `${handler.name} stub (failed)`,
      });
      try {
        await syncFile(space, sidecarRelPath);
      } finally {
        clearEditContext(space.name, sidecarRelPath);
      }
      await setEntityTag(
        space.name,
        sidecarRelPath,
        EXTRACTED_BY_TAG,
        EXTRACTED_BY_FAILED,
      );
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
 * - Sidecar has extracted_by tag = a known value other than "manual" →
 *   proceed (re-extract; the content changed).
 * - Sidecar has extracted_by = "manual" → skip (user took it over).
 * - Sidecar exists but no extracted_by tag → skip (user authored it
 *   before the extractor existed for this format).
 */
async function shouldSkipExisting(
  space: Space,
  sidecarRelPath: string,
): Promise<string | null> {
  const entity = await getEntity(space.name, sidecarRelPath);
  if (!entity) return null;

  const tags = parseTagsBag(entity.tags);
  const extractedBy = tags[EXTRACTED_BY_TAG];

  if (extractedBy === undefined || extractedBy === null) {
    return "sidecar exists without extracted_by tag (treated as manual)";
  }
  if (typeof extractedBy === "string" && extractedBy.toLowerCase() === "manual") {
    return "sidecar tagged extracted_by=manual";
  }
  return null;
}

function parseTagsBag(
  tags: Record<string, unknown> | string,
): Record<string, unknown> {
  if (typeof tags === "string") {
    try {
      return JSON.parse(tags) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return tags ?? {};
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
