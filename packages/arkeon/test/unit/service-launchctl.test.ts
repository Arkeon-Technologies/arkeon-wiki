// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseLaunchctlPrint } from "../../src/cli/lib/service/launchctl.js";

describe("parseLaunchctlPrint", () => {
  it("extracts running state + pid from a typical print output", () => {
    const out = `gui/501/tech.arkeon.wiki = {
\tactive count = 1
\tpath = /Users/test/Library/LaunchAgents/tech.arkeon.wiki.plist
\ttype = LaunchAgent
\tstate = running

\tprogram = /usr/local/bin/node
\tpid = 51234
\tlast exit code = (never exited)
}
`;
    expect(parseLaunchctlPrint(out)).toEqual({ state: "running", pid: 51234 });
  });

  it("recognizes 'not running' state and reports null pid", () => {
    const out = `gui/501/tech.arkeon.wiki = {
\tactive count = 0
\tstate = not running
}
`;
    expect(parseLaunchctlPrint(out)).toEqual({ state: "not running", pid: null });
  });

  it("returns unknown when state line is absent", () => {
    expect(parseLaunchctlPrint("")).toEqual({ state: "unknown", pid: null });
    expect(parseLaunchctlPrint("some unrelated output")).toEqual({
      state: "unknown",
      pid: null,
    });
  });

  it("tolerates varying whitespace and indentation", () => {
    const out = "  state =   running  \n      pid =   77  \n";
    expect(parseLaunchctlPrint(out)).toEqual({ state: "running", pid: 77 });
  });

  it("isn't fooled by nested 'state = active' inside coalition blocks", () => {
    // Real-world launchctl output. Without the first-match rule the
    // running state would get overwritten by the coalition's 'active'.
    const out = `gui/501/tech.arkeon.wiki.svc = {
\tactive count = 1
\tstate = running

\tpid = 40784

\tresource coalition = {
\t\tID = 103455
\t\tstate = active
\t}

\tjetsam coalition = {
\t\tstate = active
\t}
}
`;
    expect(parseLaunchctlPrint(out)).toEqual({ state: "running", pid: 40784 });
  });
});
