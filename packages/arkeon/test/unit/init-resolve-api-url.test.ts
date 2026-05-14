// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveApiUrl } from "../../src/cli/commands/repo/init.js";
import type { Instance } from "../../src/cli/lib/instances.js";

function mkInst(name: string, port: number): Instance {
  return {
    name,
    api_url: `http://localhost:${port}`,
    api_port: port,
    home: `/tmp/${name}`,
    pid: 1234,
    started_at: "2026-05-14T00:00:00.000Z",
  };
}

describe("resolveApiUrl", () => {
  it("returns ARKE_API_URL when set, regardless of running daemons", () => {
    const url = resolveApiUrl({
      env: { ARKE_API_URL: "http://elsewhere:9999" },
      findInstance: () => mkInst("default", 8000),
      listInstances: () => [mkInst("default", 8000)],
    });
    expect(url).toBe("http://elsewhere:9999");
  });

  it("returns the default instance's api_url when one is running", () => {
    const url = resolveApiUrl({
      env: {},
      findInstance: (name) => (name === "default" ? mkInst("default", 8000) : null),
      listInstances: () => [mkInst("default", 8000), mkInst("dev", 8123)],
    });
    expect(url).toBe("http://localhost:8000");
  });

  it("falls back to a sole named instance when no default is running", () => {
    const url = resolveApiUrl({
      env: {},
      findInstance: () => null,
      listInstances: () => [mkInst("dev", 8123)],
    });
    expect(url).toBe("http://localhost:8123");
  });

  it("throws a friendly error when no daemon is running", () => {
    expect(() =>
      resolveApiUrl({
        env: {},
        findInstance: () => null,
        listInstances: () => [],
      }),
    ).toThrow(/No arkeon-wiki daemon is running/);
  });

  it("throws and lists candidates when multiple named instances run with no default", () => {
    let err: Error | null = null;
    try {
      resolveApiUrl({
        env: {},
        findInstance: () => null,
        listInstances: () => [mkInst("dev-a", 8101), mkInst("dev-b", 8102)],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/Multiple arkeon-wiki daemons/);
    expect(err!.message).toContain("dev-a");
    expect(err!.message).toContain("dev-b");
    expect(err!.message).toContain("http://localhost:8101");
    expect(err!.message).toContain("http://localhost:8102");
  });

  it("env override beats default and named (priority 1 highest)", () => {
    const url = resolveApiUrl({
      env: { ARKE_API_URL: "http://override:9000" },
      findInstance: () => mkInst("default", 8000),
      listInstances: () => [mkInst("default", 8000), mkInst("dev", 8123)],
    });
    expect(url).toBe("http://override:9000");
  });
});
