// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLaunchdManager } from "../../src/cli/lib/service/launchd.js";
import type {
  LaunchctlResult,
  LaunchctlRunner,
} from "../../src/cli/lib/service/launchctl.js";
import type { InstallOptions } from "../../src/cli/lib/service/index.js";

interface Call {
  args: string[];
}

/**
 * Build a launchctl runner that records every invocation and returns
 * the queued result for that subcommand. Defaults to "no service
 * loaded" / "ok".
 */
function fakeLaunchctl(
  queue: Record<string, LaunchctlResult[]>,
): { run: LaunchctlRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: LaunchctlRunner = async (args) => {
    calls.push({ args: [...args] });
    const sub = args[0]!;
    const queued = queue[sub];
    if (queued && queued.length > 0) {
      return queued.shift()!;
    }
    if (sub === "print") {
      return { stdout: "", stderr: "Could not find service", exitCode: 113 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

let home: string;
const INSTALL_OPTS: InstallOptions = {
  name: "default",
  home: "/Users/test/.arkeon-wiki",
  paths: {
    nodeBin: "/usr/local/bin/node",
    cliEntry: "/Users/test/arkeon-wiki/dist/index.js",
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "launchd-mgr-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("createLaunchdManager — install", () => {
  it("writes the plist + bootstraps + kickstarts + reports running", async () => {
    const printRunning: LaunchctlResult = {
      stdout: "state = running\npid = 9999\n",
      stderr: "",
      exitCode: 0,
    };
    const { run, calls } = fakeLaunchctl({ print: [printRunning] });
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
      bootIntervalMs: 0,
    });

    const result = await mgr.install(INSTALL_OPTS);

    const expectedPath = join(home, "Library/LaunchAgents/tech.arkeon.wiki.plist");
    expect(result.unitPath).toBe(expectedPath);
    expect(result.label).toBe("tech.arkeon.wiki");
    expect(result.running).toBe(true);
    expect(result.pid).toBe(9999);

    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toContain("<string>tech.arkeon.wiki</string>");

    // Verb sequence: bootout (clear prior load) → bootstrap → kickstart → print.
    expect(calls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap", "kickstart", "print"]);
    expect(calls[1].args).toEqual(["bootstrap", "gui/501", expectedPath]);
    expect(calls[2].args).toEqual(["kickstart", "-k", "gui/501/tech.arkeon.wiki"]);
  });

  it("creates ~/Library/LaunchAgents/ if it doesn't exist", async () => {
    const { run } = fakeLaunchctl({});
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
    });

    expect(existsSync(join(home, "Library/LaunchAgents"))).toBe(false);
    await mgr.install(INSTALL_OPTS);
    expect(existsSync(join(home, "Library/LaunchAgents"))).toBe(true);
  });

  it("throws when bootstrap returns non-zero", async () => {
    const { run } = fakeLaunchctl({
      bootstrap: [{ stdout: "", stderr: "Service is disabled", exitCode: 5 }],
    });
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
    });

    await expect(mgr.install(INSTALL_OPTS)).rejects.toThrow(/bootstrap failed/);
  });

  it("polls until running, then returns the live pid", async () => {
    const notRunning: LaunchctlResult = {
      stdout: "state = not running\n",
      stderr: "",
      exitCode: 0,
    };
    const running: LaunchctlResult = {
      stdout: "state = running\npid = 4242\n",
      stderr: "",
      exitCode: 0,
    };
    const { run, calls } = fakeLaunchctl({
      print: [notRunning, notRunning, running],
    });
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 1000,
      bootIntervalMs: 0,
      sleep: async () => {},
    });

    const result = await mgr.install(INSTALL_OPTS);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(4242);
    expect(calls.filter((c) => c.args[0] === "print")).toHaveLength(3);
  });

  it("threads a named instance through plist + label + path", async () => {
    const { run, calls } = fakeLaunchctl({});
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
    });

    const result = await mgr.install({
      ...INSTALL_OPTS,
      name: "svc-test",
      home: "/Users/test/.arkeon-wiki/svc-test",
    });

    expect(result.label).toBe("tech.arkeon.wiki.svc-test");
    expect(result.unitPath).toBe(
      join(home, "Library/LaunchAgents/tech.arkeon.wiki.svc-test.plist"),
    );
    const written = readFileSync(result.unitPath, "utf-8");
    expect(written).toContain("--name");
    expect(written).toContain("<string>svc-test</string>");
    expect(calls[2]).toEqual({
      args: ["kickstart", "-k", "gui/501/tech.arkeon.wiki.svc-test"],
    });
  });
});

describe("createLaunchdManager — uninstall", () => {
  it("removes the plist and reports removed=true", async () => {
    const { run, calls } = fakeLaunchctl({});
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
    });

    await mgr.install(INSTALL_OPTS);
    const result = await mgr.uninstall({ name: "default" });

    expect(result.removed).toBe(true);
    expect(result.unitPath).toBe(
      join(home, "Library/LaunchAgents/tech.arkeon.wiki.plist"),
    );
    expect(existsSync(result.unitPath!)).toBe(false);

    // Final call should be the cleanup bootout for the label.
    const last = calls.at(-1)!;
    expect(last.args).toEqual(["bootout", "gui/501/tech.arkeon.wiki"]);
  });

  it("is idempotent — no plist on disk returns removed=false without erroring", async () => {
    const { run } = fakeLaunchctl({});
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
    });

    const result = await mgr.uninstall({ name: "default" });
    expect(result.removed).toBe(false);
    expect(result.unitPath).toBeNull();
  });
});

describe("createLaunchdManager — status", () => {
  it("returns installed=false when no plist exists", async () => {
    const { run } = fakeLaunchctl({});
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
    });
    const status = await mgr.status({ name: "default" });
    expect(status).toEqual({
      installed: false,
      running: false,
      pid: null,
      unitPath: null,
    });
  });

  it("reports installed=true but running=false when print fails after install", async () => {
    const { run } = fakeLaunchctl({});
    const mgr = createLaunchdManager({
      runLaunchctl: run,
      home,
      uid: 501,
      bootWaitMs: 0,
    });
    await mgr.install(INSTALL_OPTS);
    // After install, by default print queue is empty — fake returns
    // exit 113 ("not found"). Status should report installed-but-stopped.
    const status = await mgr.status({ name: "default" });
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.unitPath).toBe(
      join(home, "Library/LaunchAgents/tech.arkeon.wiki.plist"),
    );
  });
});
