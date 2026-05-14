// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LAUNCHD_LABEL,
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
  validateInstanceName,
} from "../../src/cli/lib/service/index.js";

const DEFAULT_OPTS = {
  name: "default",
  home: "/Users/test/.arkeon-wiki",
  paths: {
    nodeBin: "/usr/local/bin/node",
    cliEntry: "/Users/test/arkeon-wiki/dist/index.js",
  },
};

describe("validateInstanceName", () => {
  it("accepts alnum, dot, underscore, hyphen", () => {
    for (const name of ["default", "svc-test", "dev_1", "team.alpha", "abc123"]) {
      expect(() => validateInstanceName(name)).not.toThrow();
    }
  });

  it.each([
    "",
    " ",
    "has space",
    "has/slash",
    "has;semi",
    "has$var",
    "has\nnewline",
  ])("rejects %j", (bad) => {
    expect(() => validateInstanceName(bad)).toThrow();
  });
});

describe("launchdLabel", () => {
  it("returns the bare reverse-DNS label for the default instance", () => {
    expect(launchdLabel("default")).toBe(DEFAULT_LAUNCHD_LABEL);
  });

  it("appends the name as a fourth segment for named instances", () => {
    expect(launchdLabel("svc-test")).toBe("tech.arkeon.wiki.svc-test");
  });

  it("validates the name before constructing", () => {
    expect(() => launchdLabel("bad name")).toThrow();
  });
});

describe("launchdPlistPath", () => {
  it("lives under ~/Library/LaunchAgents", () => {
    expect(launchdPlistPath("tech.arkeon.wiki", "/Users/foo")).toBe(
      "/Users/foo/Library/LaunchAgents/tech.arkeon.wiki.plist",
    );
  });
});

describe("renderLaunchdPlist", () => {
  it("renders the default-instance plist verbatim", () => {
    expect(renderLaunchdPlist(DEFAULT_OPTS)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>tech.arkeon.wiki</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/test/arkeon-wiki/dist/index.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/test/.arkeon-wiki</string>
  <key>StandardOutPath</key>
  <string>/Users/test/.arkeon-wiki/arkeon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/test/.arkeon-wiki/arkeon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>ARKEON_WIKI_HOME</key>
    <string>/Users/test/.arkeon-wiki</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`);
  });

  it("threads --name through ProgramArguments for a named instance", () => {
    const plist = renderLaunchdPlist({
      ...DEFAULT_OPTS,
      name: "svc-test",
      home: "/Users/test/.arkeon-wiki/svc-test",
    });
    expect(plist).toContain("<string>tech.arkeon.wiki.svc-test</string>");
    expect(plist).toContain("    <string>start</string>\n    <string>--name</string>\n    <string>svc-test</string>");
    expect(plist).toContain("<string>/Users/test/.arkeon-wiki/svc-test</string>");
    expect(plist).toContain("<string>/Users/test/.arkeon-wiki/svc-test/arkeon.log</string>");
  });

  it("respects the KeepAlive contract — restart on crash, not on clean exit", () => {
    const plist = renderLaunchdPlist(DEFAULT_OPTS);
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<key>Crashed<\/key>\s*<true\/>\s*<\/dict>/,
    );
  });

  it("escapes XML-sensitive characters in paths", () => {
    const plist = renderLaunchdPlist({
      ...DEFAULT_OPTS,
      home: "/Users/test/dir with <special> & 'chars'",
    });
    expect(plist).toContain(
      "<string>/Users/test/dir with &lt;special&gt; &amp; &apos;chars&apos;</string>",
    );
    expect(plist).not.toContain("<special>");
    expect(plist).not.toContain("'chars'");
  });

  it("is deterministic — same input renders identical bytes", () => {
    const a = renderLaunchdPlist(DEFAULT_OPTS);
    const b = renderLaunchdPlist({ ...DEFAULT_OPTS });
    expect(a).toBe(b);
  });

  it("sets PATH for the supervisor — homebrew + standard system paths", () => {
    const plist = renderLaunchdPlist(DEFAULT_OPTS);
    expect(plist).toContain("/usr/local/bin");
    expect(plist).toContain("/opt/homebrew/bin");
  });

  it("rejects an invalid name early", () => {
    expect(() => renderLaunchdPlist({ ...DEFAULT_OPTS, name: "bad name" })).toThrow();
  });
});
