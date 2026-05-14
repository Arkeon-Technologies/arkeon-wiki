// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseSystemctlShow } from "../../src/cli/lib/service/systemctl.js";

describe("parseSystemctlShow", () => {
  it("extracts active state + main pid + load state from typical show output", () => {
    const out = `ActiveState=active
MainPID=12345
LoadState=loaded
`;
    expect(parseSystemctlShow(out)).toEqual({
      activeState: "active",
      mainPid: 12345,
      loadState: "loaded",
    });
  });

  it("treats MainPID=0 as null (systemd's 'no running process' sentinel)", () => {
    const out = `ActiveState=inactive
MainPID=0
LoadState=loaded
`;
    expect(parseSystemctlShow(out)).toEqual({
      activeState: "inactive",
      mainPid: null,
      loadState: "loaded",
    });
  });

  it("recognizes 'failed' active state and 'masked'/'not-found' load states", () => {
    expect(parseSystemctlShow("ActiveState=failed\nLoadState=not-found\nMainPID=0\n")).toEqual({
      activeState: "failed",
      mainPid: null,
      loadState: "not-found",
    });
    expect(parseSystemctlShow("ActiveState=inactive\nLoadState=masked\nMainPID=0\n")).toEqual({
      activeState: "inactive",
      mainPid: null,
      loadState: "masked",
    });
  });

  it("returns unknown states when the output doesn't contain the keys", () => {
    expect(parseSystemctlShow("")).toEqual({
      activeState: "unknown",
      mainPid: null,
      loadState: "unknown",
    });
    expect(parseSystemctlShow("SomeOtherKey=value\n")).toEqual({
      activeState: "unknown",
      mainPid: null,
      loadState: "unknown",
    });
  });

  it("tolerates blank lines and trailing whitespace", () => {
    const out = "\nActiveState=active  \n\n  MainPID=999\nLoadState=loaded\n\n";
    expect(parseSystemctlShow(out)).toEqual({
      activeState: "active",
      mainPid: 999,
      loadState: "loaded",
    });
  });

  it("preserves unknown for unrecognized active-state values", () => {
    // systemd has add-only state vocabulary; a future enum addition
    // shouldn't make us mis-report a service as 'active'. Default to
    // 'unknown' and let callers decide.
    expect(
      parseSystemctlShow("ActiveState=reloading\nMainPID=1\nLoadState=loaded\n").activeState,
    ).toBe("unknown");
  });

  it("ignores invalid MainPID values (negative, NaN)", () => {
    expect(parseSystemctlShow("MainPID=-1\n").mainPid).toBeNull();
    expect(parseSystemctlShow("MainPID=garbage\n").mainPid).toBeNull();
  });
});
