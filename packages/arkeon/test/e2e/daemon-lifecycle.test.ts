// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E smoke test for the detached-daemon lifecycle: up → status → ls →
 * down. Spawns the actual CLI as a subprocess (rather than using
 * startApi() in-process like fs-sync.test.ts) so we exercise the
 * spawn/detach/pidfile/registry plumbing that `up` adds on top of
 * `start`.
 *
 * Each test uses a unique --name so it gets its own home directory and
 * a deterministic, free-by-name port. ARKEON_WIKI_HOME is overridden to
 * a tmp dir so the test can't pollute the user's real ~/.arkeon-wiki/.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const CLI_ENTRY = join(__dirname, "..", "..", "src", "index.ts");

let testHome: string;
let testEnv: NodeJS.ProcessEnv;

// Each test uses its own --name so the deterministic port doesn't
// collide with a separate test that hasn't shut down yet.
const NAME_A = "e2e-daemon-a";
const NAME_B = "e2e-daemon-b";

interface CliResult {
  stdout: string;
  stderr: string;
  json: any;
}

async function runCli(args: string[], opts: { expectOk?: boolean } = {}): Promise<CliResult> {
  // npx tsx works whether node_modules is co-located or hoisted to a
  // parent repo (e.g. when this test runs from a git worktree).
  const { stdout, stderr } = await execFileP("npx", ["tsx", CLI_ENTRY, ...args], {
    env: testEnv,
    timeout: 30_000,
  }).catch((err) => {
    // execFile rejects on non-zero exit; we still want stdout/stderr
    if (err.stdout != null || err.stderr != null) {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    throw err;
  });

  // ok:true results go to stdout, ok:false errors go to stderr (via
  // output.error). Try stdout first, then scan stderr for the JSON
  // payload (it may be preceded by progress lines).
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

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "arkeon-wiki-e2e-"));
  testEnv = { ...process.env };
  // Strip ARKEON_WIKI_HOME so it can't leak in from another e2e file
  // sharing this worker (vitest's `isolate: false`). With it set,
  // applyName() in the child won't override it, and every named instance
  // would land in the same home — pidfile/registry collisions follow.
  delete testEnv.ARKEON_WIKI_HOME;
  // Each test cleans up its own ~/.arkeon-wiki/<name>/ at the end via
  // afterAll; nameToPortSlot gives us isolated ports per name.
});

afterAll(async () => {
  // Best-effort: stop anything still running, clean up homes
  for (const name of [NAME_A, NAME_B]) {
    try {
      await runCli(["down", "--name", name], { expectOk: false });
    } catch { /* ignore */ }
    const home = join(process.env.HOME ?? "", ".arkeon-wiki", name);
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  }
  const registry = join(process.env.HOME ?? "", ".arkeon-wiki", "instances");
  for (const name of [NAME_A, NAME_B]) {
    const f = join(registry, `${name}.json`);
    if (existsSync(f)) rmSync(f);
  }
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

describe("detached daemon lifecycle", () => {
  it("up → status → ls → down completes cleanly", async () => {
    const up = await runCli(["up", "--name", NAME_A]);
    expect(up.json.ok).toBe(true);
    expect(up.json.name).toBe(NAME_A);
    expect(up.json.pid).toBeTypeOf("number");
    expect(up.json.api_url).toMatch(/^http:\/\/localhost:\d+$/);

    // Daemon should respond to /health
    const health = await fetch(`${up.json.api_url}/health`);
    expect(health.ok).toBe(true);

    // status by name finds it
    const status = await runCli(["status", "--name", NAME_A]);
    expect(status.json.state).toBe("running");
    expect(status.json.pid).toBe(up.json.pid);

    // ls shows it
    const ls = await runCli(["ls", "--json"]);
    const entry = ls.json.instances.find((i: any) => i.name === NAME_A);
    expect(entry).toBeDefined();
    expect(entry.pid).toBe(up.json.pid);

    // down stops it
    const down = await runCli(["down", "--name", NAME_A]);
    expect(down.json.state).toBe("stopped");
    expect(down.json.pid).toBe(up.json.pid);

    // status after down: not_running (exit 2 → expectOk:false to read it)
    const post = await runCli(["status", "--name", NAME_A], { expectOk: false });
    expect(post.json.state).toBe("not_running");

    // Registry entry pruned
    const lsAfter = await runCli(["ls", "--json"]);
    expect(lsAfter.json.instances.find((i: any) => i.name === NAME_A)).toBeUndefined();
  });

  it("two named instances coexist on different ports", async () => {
    const a = await runCli(["up", "--name", NAME_A]);
    const b = await runCli(["up", "--name", NAME_B]);
    expect(a.json.api_url).not.toBe(b.json.api_url);

    // Both healthy on their own ports
    expect((await fetch(`${a.json.api_url}/health`)).ok).toBe(true);
    expect((await fetch(`${b.json.api_url}/health`)).ok).toBe(true);

    const ls = await runCli(["ls", "--json"]);
    const names = ls.json.instances.map((i: any) => i.name);
    expect(names).toContain(NAME_A);
    expect(names).toContain(NAME_B);

    await runCli(["down", "--name", NAME_A]);
    await runCli(["down", "--name", NAME_B]);
  });

  it("up against an already-running instance refuses to double-start", async () => {
    await runCli(["up", "--name", NAME_A]);

    // Second up with same name should fail (port already bound by us).
    const second = await runCli(["up", "--name", NAME_A], { expectOk: false });
    expect(second.json.ok).toBe(false);
    expect(second.json.error.message).toMatch(/already (in use|running)/i);

    await runCli(["down", "--name", NAME_A]);
  });
});
