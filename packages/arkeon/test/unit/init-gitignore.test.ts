// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGitignoreEntries } from "../../src/cli/commands/repo/init.js";

describe("ensureGitignoreEntries", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arkeon-gitignore-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function gitignorePath(): string {
    return join(dir, ".gitignore");
  }

  it("creates .gitignore with the requested entries when none exists", () => {
    expect(existsSync(gitignorePath())).toBe(false);

    const changed = ensureGitignoreEntries(dir, [".arkeon/state.json", ".env"]);
    expect(changed).toBe(true);

    const content = readFileSync(gitignorePath(), "utf-8");
    expect(content).toBe(".arkeon/state.json\n.env\n");
    // No leading newline before the first entry.
    expect(content.startsWith("\n")).toBe(false);
  });

  it("migrates legacy `.arkeon/` to `.arkeon/state.json` and appends .env", () => {
    writeFileSync(gitignorePath(), "node_modules/\n.arkeon/\n");

    const changed = ensureGitignoreEntries(dir, [".arkeon/state.json", ".env"]);
    expect(changed).toBe(true);

    const content = readFileSync(gitignorePath(), "utf-8");
    // Legacy .arkeon/ replaced in place, .env appended at end.
    expect(content).toContain("node_modules/");
    expect(content).toContain(".arkeon/state.json");
    expect(content).toContain(".env");
    expect(content).not.toMatch(/^\.arkeon\/$/m);
  });

  it("does not false-match .env against an existing .envrc line", () => {
    writeFileSync(gitignorePath(), ".envrc\n");

    const changed = ensureGitignoreEntries(dir, [".env"]);
    expect(changed).toBe(true);

    const content = readFileSync(gitignorePath(), "utf-8");
    expect(content).toContain(".envrc");
    // .env appears on its own line, not as a substring match of .envrc.
    expect(content.split("\n").map((l) => l.trim())).toContain(".env");
  });

  it("returns false and doesn't write when all entries are already present", () => {
    const initial = ".arkeon/state.json\n.env\nnode_modules/\n";
    writeFileSync(gitignorePath(), initial);

    const changed = ensureGitignoreEntries(dir, [".arkeon/state.json", ".env"]);
    expect(changed).toBe(false);
    expect(readFileSync(gitignorePath(), "utf-8")).toBe(initial);
  });

  it("appends only the missing entries, preserves existing content", () => {
    writeFileSync(gitignorePath(), "node_modules/\n.arkeon/state.json\n");

    const changed = ensureGitignoreEntries(dir, [".arkeon/state.json", ".env"]);
    expect(changed).toBe(true);

    const content = readFileSync(gitignorePath(), "utf-8");
    expect(content).toBe("node_modules/\n.arkeon/state.json\n.env\n");
  });

  it("preserves trailing-newline-less files when appending", () => {
    // Real-world .gitignores sometimes lack a final newline.
    writeFileSync(gitignorePath(), "node_modules/");

    ensureGitignoreEntries(dir, [".env"]);
    const content = readFileSync(gitignorePath(), "utf-8");
    expect(content).toBe("node_modules/\n.env\n");
  });

  it("legacy migration is skipped if state entry isn't among the requested set", () => {
    writeFileSync(gitignorePath(), ".arkeon/\n");

    // Only asking for .env — the legacy migration is gated on
    // `.arkeon/state.json` being requested, so `.arkeon/` should stay.
    ensureGitignoreEntries(dir, [".env"]);
    const content = readFileSync(gitignorePath(), "utf-8");
    expect(content).toContain(".arkeon/");
    expect(content).not.toContain(".arkeon/state.json");
    expect(content).toContain(".env");
  });
});
