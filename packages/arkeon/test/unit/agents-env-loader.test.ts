// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentEnv } from "../../src/server/agents/env-loader.js";

let dir: string;
const KEYS = [
  "TEST_AL_KEY_1",
  "TEST_AL_KEY_2",
  "TEST_AL_KEY_3",
  "TEST_AL_USER_ONLY",
  "TEST_AL_REPO_ONLY",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-env-"));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) delete process.env[k];
});

function writeEnv(path: string, contents: Record<string, string>): void {
  const lines = Object.entries(contents).map(([k, v]) => `${k}=${v}`);
  writeFileSync(path, lines.join("\n") + "\n");
}

describe("loadAgentEnv", () => {
  it("returns no loaded paths when nothing exists", () => {
    const result = loadAgentEnv({
      spaceDir: dir,
      userGlobalPath: join(dir, "missing.env"),
    });
    expect(result.loaded).toEqual([]);
  });

  it("loads user-global .env when no repo .env exists", () => {
    const userPath = join(dir, "user.env");
    writeEnv(userPath, { TEST_AL_USER_ONLY: "from-global" });

    const result = loadAgentEnv({ spaceDir: dir, userGlobalPath: userPath });

    expect(result.loaded).toEqual([userPath]);
    expect(process.env.TEST_AL_USER_ONLY).toBe("from-global");
  });

  it("loads repo .env when no user-global exists", () => {
    const repoEnv = join(dir, ".env");
    writeEnv(repoEnv, { TEST_AL_REPO_ONLY: "from-repo" });

    const result = loadAgentEnv({
      spaceDir: dir,
      userGlobalPath: join(dir, "missing.env"),
    });

    expect(result.loaded).toEqual([repoEnv]);
    expect(process.env.TEST_AL_REPO_ONLY).toBe("from-repo");
  });

  it("repo .env overrides user-global on the same key", () => {
    const userPath = join(dir, "user.env");
    const repoEnv = join(dir, ".env");
    writeEnv(userPath, { TEST_AL_KEY_1: "from-global" });
    writeEnv(repoEnv, { TEST_AL_KEY_1: "from-repo" });

    loadAgentEnv({ spaceDir: dir, userGlobalPath: userPath });

    expect(process.env.TEST_AL_KEY_1).toBe("from-repo");
  });

  it("shell env wins over both .env files", () => {
    const userPath = join(dir, "user.env");
    const repoEnv = join(dir, ".env");
    writeEnv(userPath, { TEST_AL_KEY_2: "from-global" });
    writeEnv(repoEnv, { TEST_AL_KEY_2: "from-repo" });

    process.env.TEST_AL_KEY_2 = "from-shell";
    loadAgentEnv({ spaceDir: dir, userGlobalPath: userPath });

    expect(process.env.TEST_AL_KEY_2).toBe("from-shell");
  });

  it("loads user-global keys not present in repo .env", () => {
    const userPath = join(dir, "user.env");
    const repoEnv = join(dir, ".env");
    writeEnv(userPath, {
      TEST_AL_USER_ONLY: "u",
      TEST_AL_KEY_3: "from-global",
    });
    writeEnv(repoEnv, { TEST_AL_KEY_3: "from-repo" });

    loadAgentEnv({ spaceDir: dir, userGlobalPath: userPath });

    expect(process.env.TEST_AL_USER_ONLY).toBe("u");        // only in global
    expect(process.env.TEST_AL_KEY_3).toBe("from-repo");    // overridden
  });

  it("returns load order in result.loaded (global, repo)", () => {
    const userPath = join(dir, "user.env");
    const repoEnv = join(dir, ".env");
    writeEnv(userPath, { X: "1" });
    writeEnv(repoEnv, { Y: "2" });

    const result = loadAgentEnv({ spaceDir: dir, userGlobalPath: userPath });

    expect(result.loaded).toEqual([userPath, repoEnv]);
  });

  it("works with no spaceDir (only user-global)", () => {
    const userPath = join(dir, "user.env");
    writeEnv(userPath, { TEST_AL_USER_ONLY: "u" });

    const result = loadAgentEnv({ userGlobalPath: userPath });

    expect(result.loaded).toEqual([userPath]);
    expect(process.env.TEST_AL_USER_ONLY).toBe("u");
  });
});
