// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared remote-fetch plumbing.
 *
 * Used by the `fetch` tool (which classifies the result into image / text
 * / error) and by the `add_source` tool (which writes the bytes to disk).
 * Both want the same timeout + byte cap + abort semantics, so the network
 * primitive lives here and the per-tool surface stays declarative.
 *
 * The operator kill switch (`ARKEON_WIKI_FETCH_DISABLED`) and byte cap
 * (`ARKEON_WIKI_FETCH_MAX_BYTES`) also live here so any tool that pulls
 * bytes from the network respects the same operator levers.
 */

export const FETCH_TIMEOUT_MS = 10_000;

/**
 * RAM-safety cap on body reads (default 25 MB). A multi-GB image stream
 * (accidental or hostile) would otherwise buffer entirely into memory
 * and OOM the daemon since the rotating-log change only bounds disk
 * usage. Override at deploy time via `ARKEON_WIKI_FETCH_MAX_BYTES`
 * (bytes, integer); set explicitly to a small number for low-RAM hosts,
 * or a larger one for fat-asset workflows.
 */
export const FETCH_MAX_BYTES = (() => {
  const raw = process.env.ARKEON_WIKI_FETCH_MAX_BYTES;
  if (!raw) return 25 * 1024 * 1024;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
})();

/**
 * Operator kill switch — when set to "1", "true", or "yes" (case-
 * insensitive), every network-fetching tool (`fetch`, `add_source`)
 * refuses with an error. Evaluated on each call (not at module load)
 * so an operator can flip the var on a running daemon and have it take
 * effect on next tick without bouncing the process.
 */
export function networkFetchDisabledByEnv(): boolean {
  const raw = (process.env.ARKEON_WIKI_FETCH_DISABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function normalizeMediaType(raw: string | null | undefined): string {
  if (!raw) return "application/octet-stream";
  return raw.split(";")[0]!.trim().toLowerCase();
}

export function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Stream `res.body` into a single Buffer, aborting the underlying fetch
 * (so the connection drops, not just the JS-side reader) the moment
 * cumulative bytes exceed FETCH_MAX_BYTES. Without this guard a server
 * that streams chunks past a missing/lying Content-Length could buffer
 * arbitrary bytes into memory and OOM the daemon.
 */
export async function readBodyCapped(
  res: Response,
  controller: AbortController,
): Promise<Buffer> {
  if (!res.body) {
    // No streaming body (e.g. HEAD response, empty 204). Fall back to
    // arrayBuffer; it'll just be empty in practice.
    return Buffer.from(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FETCH_MAX_BYTES) {
      controller.abort();
      try { reader.releaseLock(); } catch { /* ignore */ }
      throw new Error(
        `body exceeded cap of ${FETCH_MAX_BYTES} bytes ` +
          `(ARKEON_WIKI_FETCH_MAX_BYTES) during stream`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
  );
}

export interface RemoteFetchSuccess {
  ok: true;
  mediaType: string;
  contentDisposition: string | null;
  bytes: Buffer;
}

export interface RemoteFetchFailure {
  ok: false;
  /** Best-effort media-type from the response (may be empty on early failure). */
  mediaType: string;
  error: string;
  /** When the failure was an HTTP status, this is the numeric code. */
  status?: number;
}

export type RemoteFetchResult = RemoteFetchSuccess | RemoteFetchFailure;

/**
 * GET a URL, return the body as a Buffer plus the headers we care about
 * (media type, content-disposition). All shared transport policy lives
 * here:
 *   - 10s timeout covers headers + body
 *   - Content-Length pre-check rejects oversize declarations before any
 *     body bytes are read
 *   - Streaming cap aborts mid-transfer if the body exceeds FETCH_MAX_BYTES
 *
 * Errors are returned as `{ ok: false, error }` so callers can surface
 * structured failures without throwing.
 */
export async function fetchRemoteToBuffer(url: string): Promise<RemoteFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const mediaType = normalizeMediaType(res.headers.get("content-type"));
    if (!res.ok) {
      return {
        ok: false,
        mediaType,
        status: res.status,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    const declaredLen = parseContentLength(res.headers.get("content-length"));
    if (declaredLen != null && declaredLen > FETCH_MAX_BYTES) {
      controller.abort();
      return {
        ok: false,
        mediaType,
        error:
          `body declared ${declaredLen} bytes, exceeds cap of ` +
          `${FETCH_MAX_BYTES} (ARKEON_WIKI_FETCH_MAX_BYTES)`,
      };
    }
    const bytes = await readBodyCapped(res, controller);
    return {
      ok: true,
      mediaType,
      contentDisposition: res.headers.get("content-disposition"),
      bytes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, mediaType: "", error: message };
  } finally {
    clearTimeout(timer);
  }
}
