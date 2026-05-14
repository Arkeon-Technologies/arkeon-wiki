// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
