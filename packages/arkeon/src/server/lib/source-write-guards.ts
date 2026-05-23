// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared validation for the write-back endpoints (`POST /:space/inbox`,
 * `PUT /:space/sources/*`). Three guards:
 *
 *   - `assertSourcePath` — relative, no `..`, no NUL, not under `wiki/`.
 *     `safeResolve` already enforces the traversal rule downstream;
 *     this catches the same class earlier so the error message is
 *     specific to the source-write endpoints.
 *   - `assertTextContent` — body must be text. The write-back APIs are
 *     for corpus material (markdown, prose, JSON, etc.) — asset uploads
 *     (images, PDFs, archives) need to go through the filesystem
 *     directly, not the HTTP API. Reject if the extension is on the
 *     SKIP set (secrets), on the ASSET set (binary attachments), or
 *     if the body sniffs as binary (NUL byte in first 8 KB) and the
 *     extension isn't on the explicit text allowlist.
 *   - `sanitizeCaller` — turns the `X-Caller` header into the value
 *     we write to `entity_edits.by_role`. Allowlist `[A-Za-z0-9._-]{1,40}`,
 *     silent fallback to `"api"` for missing/invalid.
 */

import { extname } from "node:path";
import { ApiError } from "./errors.js";
import {
  ASSET_EXTENSIONS,
  SKIP_EXTENSIONS,
  TEXT_EXTENSIONS,
  sniffBufferIsText,
} from "./fs-watcher.js";

const CALLER_RE = /^[A-Za-z0-9._-]{1,40}$/;
const DEFAULT_CALLER = "api";

export function assertSourcePath(relativePath: string): void {
  if (!relativePath || relativePath.length === 0) {
    throw new ApiError(400, "validation_error", "path is required");
  }
  if (relativePath.startsWith("/")) {
    throw new ApiError(
      400,
      "validation_error",
      "path must be relative to the watch dir (no leading '/')",
    );
  }
  if (relativePath.includes("\0")) {
    throw new ApiError(400, "validation_error", "path contains a NUL byte");
  }
  const segments = relativePath.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new ApiError(
        400,
        "validation_error",
        "path must not contain '..' segments",
      );
    }
  }
  if (relativePath === "wiki" || relativePath.startsWith("wiki/")) {
    throw new ApiError(
      400,
      "validation_error",
      "wiki paths are not writable via this endpoint; use the agent edit tools",
    );
  }
}

/**
 * Throws if the upload isn't text. The write-back APIs are deliberately
 * text-only — asset uploads go through the filesystem directly so the
 * fs-watcher classifies them as kind='asset' on its own. This guard
 * keeps the HTTP write surface focused on the corpus-material use case.
 *
 *   - SKIP_EXTENSIONS (`.env`, `.pem`, …) → reject. These are secret-
 *     bearing or junk and never belong in the corpus.
 *   - ASSET_EXTENSIONS (`.pdf`, `.png`, …) → reject with a hint to
 *     drop the file on disk instead.
 *   - TEXT_EXTENSIONS (`.md`, `.txt`, …) → accept without inspection.
 *   - Otherwise sniff: NUL byte in first 8 KB → reject.
 */
export function assertTextContent(buf: Buffer, relativePath: string): void {
  const ext = extname(relativePath).toLowerCase();
  if (ext && SKIP_EXTENSIONS.has(ext)) {
    throw new ApiError(
      400,
      "validation_error",
      `extension '${ext}' is not indexable (secrets or scratch); pick a different filename`,
    );
  }
  if (ext && ASSET_EXTENSIONS.has(ext)) {
    throw new ApiError(
      400,
      "validation_error",
      `extension '${ext}' is a binary asset; this endpoint is text-only — drop the file in the watch directory and the watcher will index it as an asset`,
    );
  }
  if (ext && TEXT_EXTENSIONS.has(ext)) return;
  if (!sniffBufferIsText(buf)) {
    throw new ApiError(
      400,
      "validation_error",
      "content appears binary (NUL byte in first 8 KB) and extension is not on the text allowlist",
    );
  }
}

/**
 * Pick the `entity_edits.by_role` value. Allowlist
 * `[A-Za-z0-9._-]{1,40}` keeps the value safe to render in logs / UI
 * and prevents pathological inputs from polluting the audit table.
 * Invalid inputs fall back silently to `"api"` — attribution is
 * observability, not data integrity (see tasks/inbox-api.md).
 */
export function sanitizeCaller(raw: string | undefined | null): string {
  if (raw == null || raw.length === 0) return DEFAULT_CALLER;
  return CALLER_RE.test(raw) ? raw : DEFAULT_CALLER;
}
