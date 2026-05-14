// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEnvKeys, snapshotEnv } from "../../src/cli/lib/service/index.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "service-env-"));
  envPath = join(dir, ".env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readEnvKeys", () => {
  it("returns empty set for missing file", () => {
    expect(readEnvKeys(join(dir, "missing"))).toEqual(new Set());
  });

  it("extracts key names, ignoring comments and blanks", () => {
    writeFileSync(
      envPath,
      [
        "# comment",
        "",
        "OPENAI_API_KEY=sk-abc",
        "ANTHROPIC_API_KEY=sk-ant-xyz",
        "  WITH_LEADING_SPACE=value",
        "export EXPORTED_KEY=value",
        "not a key line",
        "=missing_name",
      ].join("\n"),
    );
    const keys = readEnvKeys(envPath);
    expect(keys).toEqual(new Set([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "WITH_LEADING_SPACE",
      "EXPORTED_KEY",
    ]));
  });
});

describe("snapshotEnv", () => {
  it("appends a key when it's in the shell but not in the file", () => {
    const result = snapshotEnv({
      keys: ["OPENAI_API_KEY"],
      envFilePath: envPath,
      shellEnv: { OPENAI_API_KEY: "sk-test-123" },
    });

    expect(result.written).toEqual(["OPENAI_API_KEY"]);
    expect(result.preserved).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(readFileSync(envPath, "utf-8")).toContain("OPENAI_API_KEY=sk-test-123");
  });

  it("preserves an existing key — never overwrites a different value", () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-PRESERVED-value\n");
    const result = snapshotEnv({
      keys: ["OPENAI_API_KEY"],
      envFilePath: envPath,
      shellEnv: { OPENAI_API_KEY: "sk-SHELL-value" },
    });

    expect(result.preserved).toEqual(["OPENAI_API_KEY"]);
    expect(result.written).toEqual([]);
    expect(readFileSync(envPath, "utf-8")).toBe("OPENAI_API_KEY=sk-PRESERVED-value\n");
  });

  it("records a key as missing when not in shell or file", () => {
    const result = snapshotEnv({
      keys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      envFilePath: envPath,
      shellEnv: {},
    });

    expect(result.missing).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(result.written).toEqual([]);
    expect(result.preserved).toEqual([]);
  });

  it("is idempotent across repeated calls", () => {
    const opts = {
      keys: ["OPENAI_API_KEY"],
      envFilePath: envPath,
      shellEnv: { OPENAI_API_KEY: "sk-test" },
    };
    const first = snapshotEnv(opts);
    const after = readFileSync(envPath, "utf-8");
    const second = snapshotEnv(opts);

    expect(first.written).toEqual(["OPENAI_API_KEY"]);
    expect(second.written).toEqual([]);
    expect(second.preserved).toEqual(["OPENAI_API_KEY"]);
    expect(readFileSync(envPath, "utf-8")).toBe(after);
  });

  it("dry-run plans without writing", () => {
    const result = snapshotEnv({
      keys: ["OPENAI_API_KEY"],
      envFilePath: envPath,
      shellEnv: { OPENAI_API_KEY: "sk-dryrun" },
      apply: false,
    });

    expect(result.written).toEqual(["OPENAI_API_KEY"]);
    expect(() => readFileSync(envPath, "utf-8")).toThrow();
  });

  it("appends without clobbering when other keys already live in the file", () => {
    writeFileSync(envPath, "OTHER_KEY=untouched\n");
    const result = snapshotEnv({
      keys: ["OPENAI_API_KEY"],
      envFilePath: envPath,
      shellEnv: { OPENAI_API_KEY: "sk-new" },
    });

    const text = readFileSync(envPath, "utf-8");
    expect(result.written).toEqual(["OPENAI_API_KEY"]);
    expect(text).toContain("OTHER_KEY=untouched");
    expect(text).toContain("OPENAI_API_KEY=sk-new");
  });

  it("adds a leading newline when the existing file doesn't end in one", () => {
    writeFileSync(envPath, "EXISTING=value");
    snapshotEnv({
      keys: ["NEW_KEY"],
      envFilePath: envPath,
      shellEnv: { NEW_KEY: "value" },
    });
    expect(readFileSync(envPath, "utf-8")).toBe("EXISTING=value\nNEW_KEY=value\n");
  });

  it("quotes values containing whitespace or special chars", () => {
    snapshotEnv({
      keys: ["A", "B", "C"],
      envFilePath: envPath,
      shellEnv: { A: "simple", B: "has space", C: 'has"quote' },
    });
    const text = readFileSync(envPath, "utf-8");
    expect(text).toContain("A=simple\n");
    expect(text).toContain('B="has space"\n');
    expect(text).toContain('C="has\\"quote"\n');
  });

  it("treats empty-string shell values as missing", () => {
    const result = snapshotEnv({
      keys: ["EMPTY_KEY"],
      envFilePath: envPath,
      shellEnv: { EMPTY_KEY: "" },
    });
    expect(result.missing).toEqual(["EMPTY_KEY"]);
    expect(result.written).toEqual([]);
  });

  it("writes the env file with 0600 permissions", () => {
    snapshotEnv({
      keys: ["OPENAI_API_KEY"],
      envFilePath: envPath,
      shellEnv: { OPENAI_API_KEY: "sk-secret" },
    });
    // Mask file-type bits; we only care about the permission bits.
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("tightens existing 0644 permissions to 0600 on idempotent re-run", () => {
    // User created the file by hand with permissive defaults — install
    // should bring it to the secret-file standard, even when nothing
    // new gets written.
    writeFileSync(envPath, "OPENAI_API_KEY=sk-existing\n");
    chmodSync(envPath, 0o644);
    expect(statSync(envPath).mode & 0o777).toBe(0o644);

    const result = snapshotEnv({
      keys: ["OPENAI_API_KEY"],
      envFilePath: envPath,
      shellEnv: { OPENAI_API_KEY: "sk-shell" },
    });

    expect(result.preserved).toEqual(["OPENAI_API_KEY"]);
    expect(result.written).toEqual([]);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("creates the empty placeholder file with 0600", () => {
    // No keys to write, no existing file — snapshotEnv still
    // creates an empty file (cosmetic). It must also enforce 0600
    // on that empty file so a later hand-edit landing a key is
    // already protected.
    snapshotEnv({
      keys: ["NOT_IN_SHELL"],
      envFilePath: envPath,
      shellEnv: {},
    });
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("dry-run does not chmod (no apply, no write)", () => {
    writeFileSync(envPath, "EXISTING=v\n");
    chmodSync(envPath, 0o644);
    snapshotEnv({
      keys: ["EXISTING"],
      envFilePath: envPath,
      shellEnv: { EXISTING: "v" },
      apply: false,
    });
    expect(statSync(envPath).mode & 0o777).toBe(0o644);
  });
});
