// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Full-product journey through the actual CLI binary (issue #47).
 *
 * Most other e2e tests use `startApi()` in-process — fast, but
 * leaves the spawn/detach/CLI/HTTP-round-trip code uncovered. This
 * test runs the published CLI (via tsx) as a separate process,
 * starts a detached daemon, hits its HTTP API for the parts the
 * existing test pattern covers, then exercises `arkeon-wiki search`
 * end-to-end against it.
 *
 * The bug class this catches: the CLI builds correctly, the daemon
 * comes up, the search command speaks the same wire format the
 * server returns, and the namespaced response shape survives JSON
 * serialization through both the daemon and the CLI's output layer.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import yaml from "js-yaml";

const execFileP = promisify(execFile);

const CLI_ENTRY = join(__dirname, "..", "..", "src", "index.ts");
const NAME = "e2e-cli-journey";

let testHome: string;
let watchDir: string;
let testEnv: NodeJS.ProcessEnv;
let apiUrl: string;
let spaceId: string;

interface CliResult {
  stdout: string;
  stderr: string;
  json: any;
}

async function runCli(
  args: string[],
  opts: { expectOk?: boolean; cwd?: string } = {},
): Promise<CliResult> {
  const { stdout, stderr } = await execFileP(
    "npx",
    ["tsx", CLI_ENTRY, ...args],
    { env: testEnv, timeout: 30_000, cwd: opts.cwd },
  ).catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
    if (err.stdout != null || err.stderr != null) {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    throw err;
  });

  let json: any = null;
  try { json = JSON.parse(stdout); } catch { /* non-JSON */ }
  if (json == null) {
    const m = stderr.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try { json = JSON.parse(m[0]); } catch { /* still non-JSON */ }
    }
  }

  if (opts.expectOk !== false && json && json.ok === false) {
    throw new Error(
      `CLI ${args.join(" ")} returned ok:false — ${JSON.stringify(json.error)}`,
    );
  }
  return { stdout, stderr, json };
}

function writeWiki(
  relativePath: string,
  properties: Record<string, unknown>,
  body: string,
): void {
  const absPath = join(watchDir, relativePath);
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const fm = yaml.dump(properties, { schema: yaml.JSON_SCHEMA, sortKeys: false }).trimEnd();
  writeFileSync(absPath, `---\n${fm}\n---\n\n${body}\n`);
}

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "arkeon-cli-journey-"));
  watchDir = join(testHome, "repo");
  mkdirSync(join(watchDir, "wiki"), { recursive: true });

  testEnv = { ...process.env };
  // Each test gets its own ~/.arkeon-wiki/<NAME>/ — let it land there
  // (matches the production path) but ensure we don't inherit a
  // stray ARKEON_WIKI_HOME from a sibling test run.
  delete testEnv.ARKEON_WIKI_HOME;

  // Spawn the detached daemon via the CLI.
  const up = await runCli(["up", "--name", NAME]);
  expect(up.json.ok).toBe(true);
  apiUrl = up.json.api_url as string;
  expect(apiUrl).toMatch(/^http:\/\/localhost:\d+$/);

  // Register a space pointing at our temp watchDir via HTTP. The
  // CLI's `init` command requires being cwd'd into the directory and
  // writes a .arkeon/state.json — mirrors the user's first-time
  // experience but is harder to thread through a test wrapper. The
  // HTTP call exercises the same server path.
  const created = await fetch(`${apiUrl}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "cli-journey-space", watch_dir: watchDir }),
  });
  spaceId = ((await created.json()) as { id: string }).id;

  // Seed a few wikis. The watcher in the spawned daemon picks them up.
  writeWiki(
    "wiki/person/marie-curie.md",
    { label: "Marie Curie", subject_type: "person" },
    "Marie Curie was a Polish-French physicist and chemist who pioneered research on radioactivity.",
  );
  writeWiki(
    "wiki/person/alan-turing.md",
    { label: "Alan Turing", subject_type: "person" },
    "Alan Turing was a British mathematician and theoretical computer scientist.",
  );
  writeWiki(
    "wiki/concept/photosynthesis.md",
    { label: "Photosynthesis", subject_type: "concept" },
    "Photosynthesis is the biological process by which plants convert sunlight into energy.",
  );

  // Wait for the watcher to sync all three wikis.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${apiUrl}/entities?type=wiki&space_id=${spaceId}&limit=10`,
    );
    const data = (await res.json()) as { entities: unknown[] };
    if ((data.entities ?? []).length === 3) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(async () => {
  // Best-effort cleanup.
  try {
    await runCli(["down", "--name", NAME], { expectOk: false });
  } catch { /* ignore */ }

  const home = join(process.env.HOME ?? "", ".arkeon-wiki", NAME);
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });

  const registry = join(process.env.HOME ?? "", ".arkeon-wiki", "instances", `${NAME}.json`);
  if (existsSync(registry)) rmSync(registry);

  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
}, 30_000);

describe("CLI search journey through detached daemon", () => {
  it("daemon is healthy and reports the three seeded wikis via /entities", async () => {
    const health = await fetch(`${apiUrl}/health`);
    expect(health.ok).toBe(true);

    const wikis = await fetch(
      `${apiUrl}/entities?type=wiki&space_id=${spaceId}&limit=10`,
    );
    const data = (await wikis.json()) as { entities: { label: string }[] };
    const labels = data.entities.map((w) => w.label).sort();
    expect(labels).toEqual(["Alan Turing", "Marie Curie", "Photosynthesis"]);
  });

  it("`arkeon-wiki search` against the running daemon returns the keyword response", async () => {
    const res = await runCli([
      "search",
      "Turing",
      "--api-url",
      apiUrl,
      "--space",
      spaceId,
    ]);

    expect(res.json.ok).toBe(true);
    expect(res.json.operation).toBe("search");
    expect(res.json.keyword).toBeDefined();
    expect(res.json.vector).toBeUndefined();

    const keywordLabels = (res.json.keyword.hits as { label: string }[]).map((h) => h.label);
    expect(keywordLabels).toContain("Alan Turing");
  });

  it("returns keyword hits for a different query", async () => {
    const res = await runCli([
      "search",
      "Curie",
      "--api-url",
      apiUrl,
      "--space",
      spaceId,
    ]);

    expect(res.json.keyword).toBeDefined();
    const labels = (res.json.keyword.hits as { label: string }[]).map((h) => h.label);
    expect(labels).toContain("Marie Curie");
  });

  it("daemon survives across multiple search invocations and reports `running` in status", async () => {
    const status = await runCli(["status", "--name", NAME]);
    expect(status.json.state).toBe("running");
    expect(status.json.pid).toBeTypeOf("number");
  });

  it("--api-url overrides a stale .arkeon/state.json (regression for the silent-ignore bug)", async () => {
    // The smoke-test agent caught: when both the root and the search
    // subcommand declared --api-url, Commander routed the value to
    // globals but runSearch read subcommand-local opts, so the user's
    // override silently lost to repoState.api_url. Then in runSearch's
    // precedence, repoState beat process.env.ARKE_API_URL anyway.
    //
    // After the fix:
    //   - --api-url is declared once, at the root program
    //   - precedence is ARKE_API_URL > repoState > default
    //   - explicit overrides win over a stale state.json
    //
    // This test creates a state.json pointing at a dead port, runs
    // `arkeon-wiki search` from that directory with --api-url pointing
    // at the real daemon, and verifies the search succeeds.
    const cwd = join(testHome, "stale-bound-dir");
    mkdirSync(join(cwd, ".arkeon"), { recursive: true });
    writeFileSync(
      join(cwd, ".arkeon", "state.json"),
      JSON.stringify({
        api_url: "http://localhost:65530", // a port nothing listens on
        space_id: "stale-space",
        space_name: "stale",
        created_at: new Date().toISOString(),
      }),
    );

    const res = await runCli(
      [
        "search",
        "Turing",
        "--api-url",
        apiUrl,
        "--space",
        spaceId,
      ],
      { cwd },
    );

    // If --api-url wins, the search reaches the real daemon and Turing
    // is found. If repoState had won, we'd have hit a connect refused
    // on port 65530.
    expect(res.json.ok).toBe(true);
    const labels = (res.json.keyword.hits as { label: string }[]).map((h) => h.label);
    expect(labels).toContain("Alan Turing");
  });
});
