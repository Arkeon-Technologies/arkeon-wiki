// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSystemdManager } from "../../src/cli/lib/service/systemd.js";
import type {
  SystemctlResult,
  SystemctlRunner,
} from "../../src/cli/lib/service/systemctl.js";
import type { InstallOptions } from "../../src/cli/lib/service/index.js";

interface Call {
  bin: "systemctl" | "loginctl";
  args: string[];
}

/**
 * Build systemctl + loginctl runners that record every invocation
 * and return queued results per first-arg subcommand.
 *
 * For systemctl, the "subcommand" is args[1] (after `--user`).
 * For loginctl, the "subcommand" is args[0].
 */
function fakeRunners(
  systemctlQueue: Record<string, SystemctlResult[]> = {},
  loginctlQueue: Record<string, SystemctlResult[]> = {},
): {
  systemctl: SystemctlRunner;
  loginctl: SystemctlRunner;
  calls: Call[];
} {
  const calls: Call[] = [];

  const systemctl: SystemctlRunner = async (args) => {
    calls.push({ bin: "systemctl", args: [...args] });
    // First positional arg after --user is the subcommand
    const sub = args[0] === "--user" ? args[1]! : args[0]!;
    const queued = systemctlQueue[sub];
    if (queued && queued.length > 0) return queued.shift()!;
    // Default success — for `show`, that means empty output (unit
    // unknown), which the manager treats as "loaded? still might be,
    // disk says yes".
    if (sub === "show") {
      return { stdout: "ActiveState=inactive\nMainPID=0\nLoadState=not-found\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const loginctl: SystemctlRunner = async (args) => {
    calls.push({ bin: "loginctl", args: [...args] });
    const sub = args[0]!;
    const queued = loginctlQueue[sub];
    if (queued && queued.length > 0) return queued.shift()!;
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  return { systemctl, loginctl, calls };
}

let home: string;
const INSTALL_OPTS: InstallOptions = {
  name: "default",
  home: "/home/test/.arkeon-wiki",
  paths: {
    nodeBin: "/usr/bin/node",
    cliEntry: "/opt/arkeon-wiki/dist/index.js",
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "systemd-mgr-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("createSystemdManager — install", () => {
  it("writes unit + reloads + enables --now + lingers + reports running", async () => {
    const showActive: SystemctlResult = {
      stdout: "ActiveState=active\nMainPID=4242\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const { systemctl, loginctl, calls } = fakeRunners({ show: [showActive] });
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "testuser",
      bootWaitMs: 0,
      bootIntervalMs: 0,
    });

    const result = await mgr.install(INSTALL_OPTS);

    const expectedPath = join(home, ".config/systemd/user/arkeon-wiki.service");
    expect(result.unitPath).toBe(expectedPath);
    expect(result.label).toBe("arkeon-wiki");
    expect(result.running).toBe(true);
    expect(result.pid).toBe(4242);

    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toContain("Description=Arkeon Wiki daemon");

    // Verb sequence on the systemctl side:
    //   daemon-reload → enable --now → try-restart → show (poll)
    // try-restart is the key piece for re-install: enable --now is a
    // no-op for an already-active service, so without try-restart a
    // reinstall with changed config would leave the OLD process running.
    const systemctlSubs = calls
      .filter((c) => c.bin === "systemctl")
      .map((c) => (c.args[0] === "--user" ? c.args[1] : c.args[0]));
    expect(systemctlSubs).toEqual(["daemon-reload", "enable", "try-restart", "show"]);

    // loginctl called with enable-linger <user>
    const linger = calls.find((c) => c.bin === "loginctl");
    expect(linger?.args).toEqual(["enable-linger", "testuser"]);

    // Happy path: linger succeeded, result reflects it.
    expect(result.lingerEnabled).toBe(true);
  });

  it("re-install with changed config restarts the running process via try-restart", async () => {
    // First install spawns the supervisor with cliEntry A; second
    // install with cliEntry B must (a) write the new unit body and
    // (b) restart the running process so the supervisor picks up B.
    const active1: SystemctlResult = {
      stdout: "ActiveState=active\nMainPID=100\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const active2: SystemctlResult = {
      stdout: "ActiveState=active\nMainPID=200\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const { systemctl, loginctl, calls } = fakeRunners({
      show: [active1, active2],
    });
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });

    await mgr.install(INSTALL_OPTS);
    calls.length = 0;

    await mgr.install({
      ...INSTALL_OPTS,
      paths: { nodeBin: "/usr/bin/node", cliEntry: "/srv/arkeon-wiki/dist/index.js" },
    });

    const verbs = calls
      .filter((c) => c.bin === "systemctl")
      .map((c) => (c.args[0] === "--user" ? c.args[1] : c.args[0]));
    // try-restart MUST appear after enable, and before the post-install show.
    expect(verbs).toContain("try-restart");
    expect(verbs.indexOf("try-restart")).toBeGreaterThan(verbs.indexOf("enable"));
    expect(verbs.indexOf("try-restart")).toBeLessThan(verbs.indexOf("show"));

    // The on-disk unit must reflect the SECOND install's cliEntry.
    const body = readFileSync(
      join(home, ".config/systemd/user/arkeon-wiki.service"),
      "utf-8",
    );
    expect(body).toContain("/srv/arkeon-wiki/dist/index.js");
    expect(body).not.toContain("/opt/arkeon-wiki/dist/index.js");
  });

  it("creates ~/.config/systemd/user/ if it doesn't exist", async () => {
    const { systemctl, loginctl } = fakeRunners();
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });

    expect(existsSync(join(home, ".config/systemd/user"))).toBe(false);
    await mgr.install(INSTALL_OPTS);
    expect(existsSync(join(home, ".config/systemd/user"))).toBe(true);
  });

  it("throws when daemon-reload fails", async () => {
    const { systemctl, loginctl } = fakeRunners({
      "daemon-reload": [{ stdout: "", stderr: "permission denied", exitCode: 1 }],
    });
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });
    await expect(mgr.install(INSTALL_OPTS)).rejects.toThrow(/daemon-reload failed/);
  });

  it("throws when enable --now fails", async () => {
    const { systemctl, loginctl } = fakeRunners({
      enable: [{ stdout: "", stderr: "unit is masked", exitCode: 1 }],
    });
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });
    await expect(mgr.install(INSTALL_OPTS)).rejects.toThrow(/enable --now/);
  });

  it("does NOT fail install when loginctl enable-linger fails, but surfaces lingerEnabled=false", async () => {
    // Polkit may refuse linger for non-root callers on some
    // distributions. Install should still succeed — user just gets
    // a service that doesn't survive logout on headless boxes — but
    // the result MUST carry lingerEnabled=false so the CLI can
    // surface a warning to the user instead of silently shipping a
    // half-broken install.
    const showActive: SystemctlResult = {
      stdout: "ActiveState=active\nMainPID=99\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const { systemctl, loginctl, calls } = fakeRunners(
      { show: [showActive] },
      { "enable-linger": [{ stdout: "", stderr: "polkit denied", exitCode: 1 }] },
    );
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });
    const result = await mgr.install(INSTALL_OPTS);
    expect(result.running).toBe(true);
    expect(result.lingerEnabled).toBe(false);
    expect(calls.some((c) => c.bin === "loginctl")).toBe(true);
  });

  it("threads --name through unit filename + ExecStart", async () => {
    const { systemctl, loginctl, calls } = fakeRunners();
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });

    const result = await mgr.install({
      ...INSTALL_OPTS,
      name: "svc-test",
      home: "/home/test/.arkeon-wiki/svc-test",
    });

    expect(result.label).toBe("arkeon-wiki-svc-test");
    expect(result.unitPath).toBe(
      join(home, ".config/systemd/user/arkeon-wiki-svc-test.service"),
    );
    const body = readFileSync(result.unitPath, "utf-8");
    expect(body).toContain("--name svc-test");
    expect(body).toContain("Description=Arkeon Wiki daemon (svc-test)");
    // enable --now should target the named unit
    const enable = calls.find((c) => c.bin === "systemctl" && c.args.includes("enable"));
    expect(enable?.args).toEqual(["--user", "enable", "--now", "arkeon-wiki-svc-test.service"]);
  });

  it("polls until active, then returns the live pid", async () => {
    const inactive: SystemctlResult = {
      stdout: "ActiveState=activating\nMainPID=0\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const active: SystemctlResult = {
      stdout: "ActiveState=active\nMainPID=777\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const { systemctl, loginctl, calls } = fakeRunners({
      show: [inactive, inactive, active],
    });
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 1000,
      bootIntervalMs: 0,
      sleep: async () => {},
    });

    const result = await mgr.install(INSTALL_OPTS);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(777);
    expect(
      calls.filter((c) => c.bin === "systemctl" && c.args.includes("show")).length,
    ).toBe(3);
  });
});

describe("createSystemdManager — uninstall", () => {
  it("disables + removes unit + reloads, reports removed=true", async () => {
    const { systemctl, loginctl, calls } = fakeRunners();
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });

    await mgr.install(INSTALL_OPTS);
    const result = await mgr.uninstall({ name: "default" });

    expect(result.removed).toBe(true);
    expect(result.unitPath).toBe(
      join(home, ".config/systemd/user/arkeon-wiki.service"),
    );
    expect(existsSync(result.unitPath!)).toBe(false);

    // Verb sequence in the uninstall path:
    // disable --now → daemon-reload → reset-failed
    const uninstallVerbs = calls
      .filter(
        (c) =>
          c.bin === "systemctl" &&
          ["disable", "daemon-reload", "reset-failed"].includes(
            c.args[1] ?? "",
          ),
      )
      .slice(-3)
      .map((c) => c.args[1]);
    expect(uninstallVerbs).toEqual(["disable", "daemon-reload", "reset-failed"]);
  });

  it("is idempotent — missing unit returns removed=false without erroring", async () => {
    const { systemctl, loginctl } = fakeRunners();
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });

    const result = await mgr.uninstall({ name: "default" });
    expect(result.removed).toBe(false);
    expect(result.unitPath).toBeNull();
  });
});

describe("createSystemdManager — start", () => {
  it("refuses when no unit is installed", async () => {
    const { systemctl, loginctl } = fakeRunners();
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });
    await expect(mgr.start({ name: "default" })).rejects.toThrow(/not installed/);
  });

  it("starts an installed service and polls until active", async () => {
    const active: SystemctlResult = {
      stdout: "ActiveState=active\nMainPID=5555\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const { systemctl, loginctl, calls } = fakeRunners({ show: [active, active] });
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });

    await mgr.install(INSTALL_OPTS);
    calls.length = 0;

    const result = await mgr.start({ name: "default" });
    expect(result.running).toBe(true);
    expect(result.pid).toBe(5555);

    const startCall = calls.find(
      (c) => c.bin === "systemctl" && c.args.includes("start"),
    );
    expect(startCall?.args).toEqual(["--user", "start", "arkeon-wiki.service"]);
  });
});

describe("createSystemdManager — status", () => {
  it("returns installed=false when no unit exists", async () => {
    const { systemctl, loginctl } = fakeRunners();
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
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

  it("reports installed=true running=false when show says inactive", async () => {
    const inactive: SystemctlResult = {
      stdout: "ActiveState=inactive\nMainPID=0\nLoadState=loaded\n",
      stderr: "",
      exitCode: 0,
    };
    const { systemctl, loginctl } = fakeRunners({ show: [inactive, inactive] });
    const mgr = createSystemdManager({
      runSystemctl: systemctl,
      runLoginctl: loginctl,
      home,
      username: "x",
      bootWaitMs: 0,
    });
    await mgr.install(INSTALL_OPTS);
    const status = await mgr.status({ name: "default" });
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });
});
