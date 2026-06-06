// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI shellout end-to-end suite.
 *
 * The existing `substrate.test.ts` exercises the HTTP surface
 * in-process via `app.fetch`. That misses every CLI failure mode:
 * commander flag-parsing, `--api-url` placement, `isTty()` branching,
 * `splitKeyValue`, exit codes, and the apiCall transport wrapper.
 *
 * This suite spawns the daemon as a real child process AND shells
 * out to the bundled `dist/index.js` binary for each CLI assertion.
 * What a published `npm i -g arkeon-wiki` user runs is what's tested
 * here.
 *
 * Closes #191.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const CLI_BIN = join(PACKAGE_ROOT, "dist", "index.js");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): CliResult {
  const r = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      // FORCE_COLOR=0 isn't load-bearing for our CLI (we don't emit
      // ANSI), but it keeps tests robust against future colorization.
      // Stdio is piped, so isTty() is already false — the JSON
      // branch is what every assertion below reads.
      FORCE_COLOR: "0",
      ...opts.env,
    },
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === "object" && addr) resolveP(addr.port);
        else rejectP(new Error("could not pick free port"));
      });
    });
  });
}

async function waitReady(base: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`daemon never became ready at ${base}`);
}

async function waitForArtifact(
  base: string,
  path: string,
  timeoutMs = 10_000,
): Promise<void> {
  // This poll depends on `/tags?path=…` returning a NON-2xx status
  // (today: 404) when the artifact hasn't been indexed yet. If the
  // route ever changes to "always 200 with an empty tag map," this
  // loop silently returns instantly and the CLI cases race the
  // watcher. Future-you: update the poll predicate when that
  // happens — don't trust the loop to keep gating.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/tags?path=${encodeURIComponent(path)}`);
      if (r.ok) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`artifact ${path} never indexed at ${base}`);
}

describe("cli shellout", () => {
  let workdir: string;
  let stateDir: string;
  let port: number;
  let unreachablePort: number;
  let baseUrl: string;
  let daemon: ChildProcess;

  beforeAll(async () => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(
        `CLI binary missing at ${CLI_BIN}. The e2e global setup should have built it — run \`npm run build -w packages/arkeon\` to repair.`,
      );
    }

    workdir = mkdtempSync(join(tmpdir(), "arkeon-cli-shellout-corpus-"));
    stateDir = mkdtempSync(join(tmpdir(), "arkeon-cli-shellout-state-"));
    port = await pickFreePort();
    // Pick a separate free port for the "network unreachable" test.
    // Nothing binds to it, so any connect attempt refuses quickly.
    unreachablePort = await pickFreePort();
    // The daemon registers itself in the instances registry as
    // `http://localhost:<port>` (see `start.ts`). Align baseUrl with
    // that string so the `where` assertion matches verbatim — and so
    // `--api-url` overrides we pass below resolve identically to the
    // registry's view.
    //
    // Caveat for future-you: on hosts where Node's DNS prefers IPv6,
    // `localhost` can resolve to `::1`. The daemon binds to
    // `127.0.0.1` only, so a v6-first resolution would fail every
    // fetch. CI (Ubuntu) and local macOS both resolve v4 first
    // today; if a connect-refused mystery ever appears, swap to
    // `127.0.0.1` and update the `where` assertion to match on port
    // instead of the verbatim URL.
    baseUrl = `http://localhost:${port}`;

    // Corpus: one HTML article, one Markdown source with a wikilink
    // back to the article. Enough to exercise tag / query / backlinks.
    mkdirSync(join(workdir, "iarpa/sources"), { recursive: true });
    writeFileSync(
      join(workdir, "iarpa/article.html"),
      `<!doctype html><html><head><title>India</title></head><body><p>article body</p></body></html>`,
    );
    writeFileSync(
      join(workdir, "iarpa/sources/notes.md"),
      `# Notes\n\nLinks to [[article]] for context.\n`,
    );

    daemon = spawn(
      process.execPath,
      [
        CLI_BIN,
        "start",
        "--name",
        "shellout-test",
        "--port",
        String(port),
        "--watch-dir",
        workdir,
      ],
      {
        env: {
          ...process.env,
          ARKEON_WIKI_HOME: stateDir,
        },
        // stdin ignored, stdout muted (daemon's "Ready" banner is
        // noise during a green run), stderr inherited so any crash
        // or unhandled rejection surfaces in the vitest reporter
        // when something does go wrong on CI.
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    daemon.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[cli-shellout] daemon spawn error:", err);
    });

    await waitReady(baseUrl);
    await waitForArtifact(baseUrl, "iarpa/article.html");
    await waitForArtifact(baseUrl, "iarpa/sources/notes.md");
  }, 60_000);

  afterAll(async () => {
    if (daemon && !daemon.killed) {
      daemon.kill("SIGTERM");
      await new Promise<void>((res) => {
        const timer = setTimeout(() => res(), 3_000);
        daemon.once("exit", () => {
          clearTimeout(timer);
          res();
        });
      });
    }
    rmSync(workdir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("`where` resolves the instance via CWD walk", () => {
    // Run from inside the watched root so the CWD-walk resolution
    // source kicks in. Anything else (no --name, no env override)
    // means whatever `where` reports came from the registry lookup.
    const r = runCli(["where", "--json"], { cwd: workdir });
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      operation: string;
      source: string;
      api_url: string;
      instance: string | null;
    };
    expect(body.operation).toBe("where");
    expect(body.instance).toBe("shellout-test");
    expect(body.api_url).toBe(baseUrl);
  });

  it("`stats` emits valid JSON in piped mode", () => {
    const r = runCli(["stats", "--api-url", baseUrl]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      artifacts: { total: number; text: number; asset: number };
      links: number;
      redlinks: number;
      tag_keys: number;
      tag_keys_top: Array<{ key: string; n: number }>;
    };
    // ≥2 indexed artifacts (article.html + notes.md). MD source
    // doesn't get a sidecar so no asset rows from this corpus.
    expect(body.artifacts.total).toBeGreaterThanOrEqual(2);
    expect(body.artifacts.text).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.tag_keys_top)).toBe(true);
  });

  it("`query --kinds text` returns the corpus paths", () => {
    const r = runCli(
      ["query", "--api-url", baseUrl, "--kinds", "text"],
    );
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      artifacts: Array<{ path: string }>;
      total: number;
    };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toContain("iarpa/article.html");
    expect(paths).toContain("iarpa/sources/notes.md");
  });

  it("`tag <path> k=v` creates a fresh tag (action=created)", () => {
    const r = runCli([
      "tag",
      "iarpa/article.html",
      "review=pending",
      "--api-url",
      baseUrl,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      ok: boolean;
      action: string;
      previous_value: string | null;
      value: string;
    };
    expect(body.ok).toBe(true);
    expect(body.action).toBe("created");
    expect(body.previous_value).toBeNull();
    expect(body.value).toBe("pending");
  });

  it("re-tagging with the same value is action=unchanged", () => {
    const r = runCli([
      "tag",
      "iarpa/article.html",
      "review=pending",
      "--api-url",
      baseUrl,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      action: string;
      previous_value: string | null;
    };
    expect(body.action).toBe("unchanged");
    expect(body.previous_value).toBe("pending");
  });

  it("re-tagging with a different value is action=updated + carries previous_value", () => {
    const r = runCli([
      "tag",
      "iarpa/article.html",
      "review=approved",
      "--api-url",
      baseUrl,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      action: string;
      previous_value: string | null;
      value: string;
    };
    expect(body.action).toBe("updated");
    expect(body.previous_value).toBe("pending");
    expect(body.value).toBe("approved");
  });

  it("`tag <path> k=v=with=equals` keeps `=` inside the value (splitKeyValue)", () => {
    // Regression on the value-contains-= edge case. `processed-by-*`
    // tags routinely carry content hashes like `editor=hash=abc123`,
    // and splitting on every `=` would shred them. The CLI must
    // split on the FIRST `=` only.
    const r = runCli([
      "tag",
      "iarpa/article.html",
      "processed-by-editor=hash=abc123",
      "--api-url",
      baseUrl,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      key: string;
      value: string;
    };
    expect(body.key).toBe("processed-by-editor");
    expect(body.value).toBe("hash=abc123");
  });

  it("`untag <path> k` reports existed=true on the first call", () => {
    const r = runCli([
      "untag",
      "iarpa/article.html",
      "review",
      "--api-url",
      baseUrl,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as { ok: boolean; existed: boolean };
    expect(body.ok).toBe(true);
    expect(body.existed).toBe(true);
  });

  it("`untag` on the same key again is idempotent (existed=false, still exit 0)", () => {
    const r = runCli([
      "untag",
      "iarpa/article.html",
      "review",
      "--api-url",
      baseUrl,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as { ok: boolean; existed: boolean };
    expect(body.ok).toBe(true);
    expect(body.existed).toBe(false);
  });

  it("`backlinks <real-path>` reports exists=true + demand from notes.md", () => {
    const r = runCli([
      "backlinks",
      "iarpa/article.html",
      "--api-url",
      baseUrl,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      exists: boolean;
      demand: number;
      backlinks: Array<{ source_path: string }>;
    };
    expect(body.exists).toBe(true);
    // notes.md has `[[article]]` which resolves to article.html.
    expect(body.demand).toBeGreaterThanOrEqual(1);
    expect(body.backlinks.map((b) => b.source_path)).toContain(
      "iarpa/sources/notes.md",
    );
  });

  it("`tag <nonexistent-path> k=v` exits 1 with a 4xx surfaced (artifact not in index)", () => {
    const r = runCli([
      "tag",
      "definitely/does/not/exist.html",
      "k=v",
      "--api-url",
      baseUrl,
    ]);
    // apiCall returns exit 1 on 4xx/5xx, exit 2 on transport. 404 is
    // the right error and the right exit code here.
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/HTTP 404|not_found/);
  });

  it("`--api-url <unreachable>` exits 2 (network error, not HTTP)", () => {
    const r = runCli([
      "stats",
      "--api-url",
      `http://localhost:${unreachablePort}`,
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot reach/);
  });

  it("`--api-url` is accepted AFTER the subcommand (addCommonOptions placement)", () => {
    // The classic commander footgun: program-level options must come
    // BEFORE the subcommand. #190 deliberately declared `--api-url`
    // via `addCommonOptions` on every api command so users can write
    // `arkeon-wiki query --api-url X` without a parse failure. This
    // regression-tests that decision.
    const r = runCli(["query", "--api-url", baseUrl, "--kinds", "text"]);
    expect(r.status, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as { total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
  });
});
