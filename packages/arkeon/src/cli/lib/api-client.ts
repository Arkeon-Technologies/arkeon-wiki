// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTTP client for the api-CLI commands (`query`, `tag`, ...).
 *
 * Every command does the same thing: resolve which daemon to hit,
 * issue a JSON request, exit with a useful code on failure. This
 * module owns that whole flow so the command files stay tiny.
 *
 * Exit codes (set on the returned process when `exitOnError` is true,
 * which is the default for command-line use):
 *   0  success
 *   1  the API responded with a 4xx/5xx — error payload printed to stderr
 *   2  network error reaching the daemon (daemon down, wrong port, etc.)
 */

import { resolveTarget, type ResolveOptions } from "./instance-resolve.js";

export interface ApiCallOptions extends ResolveOptions {
  /** Override `Authorization: Bearer <token>`. Falls back to ARKEON_WIKI_TOKEN. */
  token?: string;
  /** When false, throws instead of calling process.exit. Used by tests. */
  exitOnError?: boolean;
}

/**
 * Build a URL from base + path + optional query params. Tolerates
 * trailing slashes on base and missing leading slashes on path so
 * callers don't need to worry. `null`/`undefined` query values are
 * dropped — `apiCall` callers pass the flag object straight through.
 *
 * Exported for unit testing.
 */
export function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined | null>,
): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${trimmedBase}${trimmedPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Resolve the bearer token. `--token` (`opts.token`) wins; falls back
 * to `ARKEON_WIKI_TOKEN` from `opts.env` (defaults to `process.env`).
 * Returns an empty header map when no token is set.
 *
 * Exported for unit testing.
 */
export function authHeader(opts: ApiCallOptions): Record<string, string> {
  const token = opts.token ?? (opts.env ?? process.env).ARKEON_WIKI_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Strip `undefined` and `null` from a JSON request body so callers can
 * forward raw flag objects — an absent `--limit` becomes a missing
 * field rather than a literal `null`. Returns `undefined` when no body
 * was given so GET requests don't send a `Content-Type` header.
 *
 * Exported for unit testing.
 */
export function cleanRequestBody(body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined) return undefined;
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    filtered[k] = v;
  }
  return JSON.stringify(filtered);
}

/**
 * Issue a JSON request against the resolved daemon.
 *
 * Strips `undefined` and `null` from JSON bodies so callers can pass
 * the raw flag object without filtering — `--limit` left off becomes
 * an absent field rather than `null`.
 */
export async function apiCall<T = unknown>(
  method: "GET" | "POST",
  path: string,
  args: {
    body?: Record<string, unknown>;
    query?: Record<string, string | number | undefined | null>;
  } = {},
  opts: ApiCallOptions = {},
): Promise<T> {
  const exitOnError = opts.exitOnError !== false;
  let target;
  try {
    target = resolveTarget(opts);
  } catch (err) {
    return failResolve(err as Error, exitOnError);
  }

  const url = buildUrl(target.api_url, path, args.query);
  const body = cleanRequestBody(args.body);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...authHeader(opts),
      },
      body,
    });
  } catch (err) {
    return failNetwork(url, err as Error, exitOnError);
  }

  if (!res.ok) {
    return failHttp(url, res, exitOnError);
  }

  // The substrate always returns JSON. If something else comes back,
  // surface that loudly rather than guess.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return failNetwork(
      url,
      new Error(
        `Expected JSON response, got content-type=${contentType || "<empty>"}`,
      ),
      exitOnError,
    );
  }
  return (await res.json()) as T;
}

function failResolve(err: Error, exitOnError: boolean): never {
  if (!exitOnError) throw err;
  process.stderr.write(`arkeon-wiki: ${err.message}\n`);
  process.exit(2);
}

function failNetwork(url: string, err: Error, exitOnError: boolean): never {
  const msg = `arkeon-wiki: cannot reach ${url}: ${err.message}`;
  if (!exitOnError) throw new Error(msg);
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

async function failHttp(url: string, res: Response, exitOnError: boolean): Promise<never> {
  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  const msg = `arkeon-wiki: ${url} → HTTP ${res.status} ${res.statusText}${bodyText ? `\n${bodyText}` : ""}`;
  if (!exitOnError) throw new Error(msg);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}
