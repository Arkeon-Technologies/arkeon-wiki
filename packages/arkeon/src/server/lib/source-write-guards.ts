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
 *   - `assertTextContent` — body must not look binary. Same heuristic
 *     the watcher uses: if the extension is in `TEXT_EXTENSIONS` we
 *     trust it; otherwise the first 8 KB must have no NUL byte, AND
 *     the extension must not be in `BINARY_EXTENSIONS`.
 *   - `sanitizeCaller` — turns the `X-Caller` header into the value
 *     we write to `entity_edits.by_role`. Allowlist `[A-Za-z0-9._-]{1,40}`,
 *     silent fallback to `"api"` for missing/invalid.
 */

import { extname } from "node:path";
import { ApiError } from "./errors.js";
import {
  BINARY_EXTENSIONS,
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
 * Throws if `buf` looks binary AND the extension isn't on the text
 * allowlist. Mirrors `isEligibleFile`: explicit text extensions short-
 * circuit; explicit binary extensions always reject; anything else
 * falls back to the NUL sniff.
 */
export function assertTextContent(buf: Buffer, relativePath: string): void {
  const ext = extname(relativePath).toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    throw new ApiError(
      400,
      "validation_error",
      `extension '${ext}' is not indexable; upload as a text format`,
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
