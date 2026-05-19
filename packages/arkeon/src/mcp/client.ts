// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

// Thin HTTP wrapper around the arkeon-wiki daemon's API. Used only by the
// MCP server — each tool composes one or two requests through here.
//
// Errors are surfaced as `HttpError` with the response status code, so
// callers can branch on `err.status === 409` (collision retry) etc.
// without parsing a string template.
//
// Config precedence (highest first):
//   1. explicit argument passed to a method (e.g. `space` override)
//   2. ARKEON_WIKI_URL / ARKEON_WIKI_SPACE / ARKEON_WIKI_CALLER env vars
//   3. defaults (URL = http://localhost:8000, no default space, caller = "mcp")
//
// The MCP entry point is registered per-space in claude_desktop_config.json:
// each entry binds env vars, so the model never has to thread `space`
// through every tool call. Tools still accept a `space` override for the
// rare power-user case (multi-wiki query from one MCP instance).

const DEFAULT_API_URL = "http://localhost:8000";
const DEFAULT_CALLER = "mcp";

export class HttpError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.name = "HttpError";
  }
}

export interface ClientConfig {
  apiUrl: string;
  space?: string;
  caller: string;
}

export function loadConfig(): ClientConfig {
  return {
    apiUrl: (process.env.ARKEON_WIKI_URL ?? DEFAULT_API_URL).replace(/\/$/, ""),
    space: process.env.ARKEON_WIKI_SPACE,
    caller: process.env.ARKEON_WIKI_CALLER ?? DEFAULT_CALLER,
  };
}

export class ArkeonWikiClient {
  constructor(private readonly config: ClientConfig = loadConfig()) {}

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  get defaultSpace(): string | undefined {
    return this.config.space;
  }

  get caller(): string {
    return this.config.caller;
  }

  resolveSpace(override?: string): string {
    const space = override ?? this.config.space;
    if (!space) {
      throw new Error(
        "No space resolved. Set ARKEON_WIKI_SPACE in your Claude Desktop env, or pass `space` as a tool argument.",
      );
    }
    return space;
  }

  async getJson<T = unknown>(path: string, query?: Record<string, string | string[] | number | undefined>): Promise<T> {
    const url = new URL(this.config.apiUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new HttpError("GET", url.pathname, res.status, await safeText(res));
    }
    return (await res.json()) as T;
  }

  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.config.apiUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Caller": this.config.caller,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new HttpError("POST", path, res.status, await safeText(res));
    }
    return (await res.json()) as T;
  }

  async putRaw<T = unknown>(
    path: string,
    body: string,
    opts: { contentType?: string; overwrite?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.config.apiUrl + path);
    if (opts.overwrite) url.searchParams.set("overwrite", "true");
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": opts.contentType ?? "text/markdown",
        "X-Caller": this.config.caller,
      },
      body,
    });
    if (!res.ok) {
      throw new HttpError("PUT", path, res.status, await safeText(res));
    }
    return (await res.json()) as T;
  }

  /**
   * Build the human-facing reader URL for an entity. Used in tool text
   * output so the model can emit clickable citations without having to
   * separately call daemon_status to learn the port. e.g.
   *   entityUrl("iarpa", "wiki/foo.html") → http://localhost:8186/iarpa/wiki/foo.html
   */
  entityUrl(space: string, sourcePath: string): string {
    return `${this.config.apiUrl}/${encodeURIComponent(space)}/${sourcePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  async health(): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await fetch(this.config.apiUrl + "/health");
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "<no body>";
  }
}
