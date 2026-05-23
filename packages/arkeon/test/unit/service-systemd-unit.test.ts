// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";

import {
  renderSystemdUnit,
  systemdUnitName,
  systemdUnitPath,
  UNIT_PREFIX,
} from "../../src/cli/lib/service/systemd-unit.js";

const DEFAULT_OPTS = {
  name: "default",
  home: "/home/test/.arkeon-wiki",
  paths: {
    nodeBin: "/usr/bin/node",
    cliEntry: "/opt/arkeon-wiki/dist/index.js",
  },
};

describe("systemdUnitName", () => {
  it("returns the bare prefix for the default instance", () => {
    expect(systemdUnitName("default")).toBe(UNIT_PREFIX);
  });

  it("hyphenates the name for a --name instance", () => {
    expect(systemdUnitName("svc-test")).toBe("arkeon-wiki-svc-test");
  });

  it("validates the name before constructing", () => {
    expect(() => systemdUnitName("bad name")).toThrow();
  });
});

describe("systemdUnitPath", () => {
  it("lives under ~/.config/systemd/user", () => {
    expect(systemdUnitPath("arkeon-wiki", "/home/foo")).toBe(
      "/home/foo/.config/systemd/user/arkeon-wiki.service",
    );
  });

  it("defaults to the user's real $HOME when no home is given", () => {
    expect(systemdUnitPath("arkeon-wiki")).toBe(
      `${homedir()}/.config/systemd/user/arkeon-wiki.service`,
    );
  });
});

describe("renderSystemdUnit", () => {
  it("renders the default-instance unit verbatim", () => {
    // Pin $HOME-derived EnvironmentFile path so the golden comparison
    // is deterministic across machines.
    const expectedUserGlobalEnv = `${homedir()}/.arkeon-wiki/.env`;
    expect(renderSystemdUnit(DEFAULT_OPTS)).toBe(`[Unit]
Description=Arkeon Wiki daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/arkeon-wiki/dist/index.js start
WorkingDirectory=/home/test/.arkeon-wiki
Environment=ARKEON_WIKI_HOME=/home/test/.arkeon-wiki
Environment=ARKEON_WIKI_LOG_ROTATE=1
EnvironmentFile=-${expectedUserGlobalEnv}
EnvironmentFile=-/home/test/.arkeon-wiki/.env
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/test/.arkeon-wiki/arkeon.log
StandardError=append:/home/test/.arkeon-wiki/arkeon.log

[Install]
WantedBy=default.target
`);
  });

  it("threads --name through ExecStart + Description for named instances", () => {
    const unit = renderSystemdUnit({
      ...DEFAULT_OPTS,
      name: "svc-test",
      home: "/home/test/.arkeon-wiki/svc-test",
    });
    expect(unit).toContain("Description=Arkeon Wiki daemon (svc-test)");
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /opt/arkeon-wiki/dist/index.js start --name svc-test",
    );
    expect(unit).toContain("WorkingDirectory=/home/test/.arkeon-wiki/svc-test");
    expect(unit).toContain(
      "EnvironmentFile=-/home/test/.arkeon-wiki/svc-test/.env",
    );
    expect(unit).toContain(
      "StandardOutput=append:/home/test/.arkeon-wiki/svc-test/arkeon.log",
    );
  });

  it("respects the Restart contract — on-failure, not on clean exit", () => {
    const unit = renderSystemdUnit(DEFAULT_OPTS);
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).not.toContain("Restart=always");
    expect(unit).not.toContain("Restart=on-success");
  });

  it("uses the optional-file EnvironmentFile syntax (leading dash)", () => {
    // Without the leading dash, a missing .env file would make
    // systemctl refuse to start the unit — fragile on first install
    // before any keys are populated.
    const unit = renderSystemdUnit(DEFAULT_OPTS);
    expect(unit).toMatch(/^EnvironmentFile=-/m);
    // Both env-file lines must be optional.
    const optionalEnvLines = unit
      .split("\n")
      .filter((l) => l.startsWith("EnvironmentFile=")).length;
    const optionalDashed = unit
      .split("\n")
      .filter((l) => l.startsWith("EnvironmentFile=-")).length;
    expect(optionalDashed).toBe(optionalEnvLines);
    expect(optionalEnvLines).toBe(2);
  });

  it("is deterministic — same input renders identical bytes", () => {
    const a = renderSystemdUnit(DEFAULT_OPTS);
    const b = renderSystemdUnit({ ...DEFAULT_OPTS });
    expect(a).toBe(b);
  });

  it("targets default.target — the user-mode equivalent of multi-user.target", () => {
    expect(renderSystemdUnit(DEFAULT_OPTS)).toMatch(/^WantedBy=default\.target$/m);
  });

  it("does not embed secrets — keys flow via the EnvironmentFile path only", () => {
    // Defense in depth: even if a future change passes API keys via
    // InstallOptions, the renderer never emits an `Environment=` line
    // with a name matching a known secret. Today there's no path for
    // that — but lock it down so a future bug stays caught.
    const unit = renderSystemdUnit({
      ...DEFAULT_OPTS,
      // @ts-expect-error - probing that extra fields don't bleed
      paths: { ...DEFAULT_OPTS.paths, OPENAI_API_KEY: "should-not-appear" },
    });
    expect(unit).not.toContain("OPENAI_API_KEY");
    expect(unit).not.toContain("should-not-appear");
  });

  it("rejects an invalid name early", () => {
    expect(() => renderSystemdUnit({ ...DEFAULT_OPTS, name: "bad name" })).toThrow();
  });

  it("quotes ExecStart paths that contain spaces", () => {
    // systemd ExecStart is whitespace-tokenized — `/foo bar/node`
    // parses as executable `/foo` + arg `bar/node` unless we quote.
    // The instance-name validator catches spaces in `name`, but the
    // snapshotted paths (nvm/fnm directory under "My Stuff/", etc.)
    // are user-provided and can legitimately contain spaces.
    const unit = renderSystemdUnit({
      ...DEFAULT_OPTS,
      paths: {
        nodeBin: "/home/test/Code Stuff/node/bin/node",
        cliEntry: "/home/test/arkeon-wiki/dist/index.js",
      },
    });
    expect(unit).toContain(
      'ExecStart="/home/test/Code Stuff/node/bin/node" /home/test/arkeon-wiki/dist/index.js start',
    );
  });

  it("leaves safe paths unquoted (keeps unit files readable)", () => {
    const unit = renderSystemdUnit(DEFAULT_OPTS);
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /opt/arkeon-wiki/dist/index.js start",
    );
  });

  it("escapes embedded quotes and backslashes in ExecStart args", () => {
    const unit = renderSystemdUnit({
      ...DEFAULT_OPTS,
      paths: {
        nodeBin: '/home/x "weird"/node',
        cliEntry: "/home/x \\back/dist/index.js",
      },
    });
    expect(unit).toContain(
      'ExecStart="/home/x \\"weird\\"/node" "/home/x \\\\back/dist/index.js" start',
    );
  });
});
