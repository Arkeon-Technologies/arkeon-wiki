// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

import { buildLlmConfigFromFlags, parseEnv } from "../../src/cli/lib/local.js";
import {
  clearLlmConfig,
  llmConfigFile,
  loadOrCreateSecrets,
  readLlmConfig,
  readSecrets,
  secretsFile,
  writeLlmConfig,
} from "../../src/cli/lib/local-runtime.js";

// ---------------------------------------------------------------------------
// parseEnv — minimal dotenv-style parser (still exported for external-mode
// .env loading, so the core behavior is still worth testing)
// ---------------------------------------------------------------------------

describe("parseEnv", () => {
  test("parses simple KEY=value lines", () => {
    expect(parseEnv("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  test("skips blank lines and comments", () => {
    const text = ["# a comment", "", "A=1", "   # indented comment", "B=2"].join("\n");
    expect(parseEnv(text)).toEqual({ A: "1", B: "2" });
  });

  test("strips surrounding double quotes", () => {
    expect(parseEnv('A="hello"')).toEqual({ A: "hello" });
  });

  test("strips surrounding single quotes", () => {
    expect(parseEnv("A='hello'")).toEqual({ A: "hello" });
  });

  test("empty value is an empty string, not undefined", () => {
    expect(parseEnv("A=")).toEqual({ A: "" });
  });

  test("value with `=` inside is preserved after the first =", () => {
    expect(parseEnv("DATABASE_URL=postgres://user:pass@host/db?sslmode=require")).toEqual({
      DATABASE_URL: "postgres://user:pass@host/db?sslmode=require",
    });
  });
});

// ---------------------------------------------------------------------------
// buildLlmConfigFromFlags — partial-flag validation for `arkeon init`
// ---------------------------------------------------------------------------

describe("buildLlmConfigFromFlags", () => {
  const full = {
    llmProvider: "openai",
    llmBaseUrl: "https://api.openai.com/v1",
    llmApiKey: "sk-test",
    llmModel: "gpt-4.1-nano",
  };

  test("returns null when no flags are provided", () => {
    expect(buildLlmConfigFromFlags({})).toBeNull();
  });

  test("returns a full default-scoped config when all four flags are provided", () => {
    expect(buildLlmConfigFromFlags(full)).toEqual({
      default: {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        model: "gpt-4.1-nano",
      },
    });
  });

  test("throws naming the missing flags when only provider is given", () => {
    expect(() => buildLlmConfigFromFlags({ llmProvider: "openai" })).toThrow(
      /--llm-base-url, --llm-api-key, --llm-model/,
    );
  });

  test("throws naming the missing flags when three of four are given", () => {
    expect(() =>
      buildLlmConfigFromFlags({
        llmProvider: "openai",
        llmBaseUrl: "https://api.openai.com/v1",
        llmApiKey: "sk-test",
      }),
    ).toThrow(/--llm-model/);
  });

  test("throws on an invalid base URL", () => {
    expect(() =>
      buildLlmConfigFromFlags({ ...full, llmBaseUrl: "not a url" }),
    ).toThrow(/not a valid URL/);
  });

  test("accepts any OpenAI-compatible provider label (no hardcoded allowlist)", () => {
    const cfg = buildLlmConfigFromFlags({
      llmProvider: "openrouter",
      llmBaseUrl: "https://openrouter.ai/api/v1",
      llmApiKey: "sk-or-v1-xxx",
      llmModel: "anthropic/claude-3.5-sonnet",
    });
    expect(cfg?.default?.provider).toBe("openrouter");
    expect(cfg?.default?.model).toBe("anthropic/claude-3.5-sonnet");
  });

  test("accepts a localhost URL for local provider endpoints", () => {
    const cfg = buildLlmConfigFromFlags({
      llmProvider: "local",
      llmBaseUrl: "http://localhost:11434/v1",
      llmApiKey: "ollama",
      llmModel: "llama3",
    });
    expect(cfg?.default?.base_url).toBe("http://localhost:11434/v1");
  });
});

// ---------------------------------------------------------------------------
// LLM config roundtrip (writes to ~/.arkeon-wiki/llm.json with 0600)
// ---------------------------------------------------------------------------

describe("LLM config", () => {
  let scratch: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.ARKEON_WIKI_HOME;
    scratch = mkdtempSync(join(tmpdir(), "arkeon-cli-test-"));
    process.env.ARKEON_WIKI_HOME = scratch;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.ARKEON_WIKI_HOME = prevHome;
    else delete process.env.ARKEON_WIKI_HOME;
    rmSync(scratch, { recursive: true, force: true });
  });

  test("readLlmConfig returns null when no file exists", () => {
    expect(readLlmConfig()).toBeNull();
  });

  test("writeLlmConfig roundtrips via readLlmConfig with per-step overrides", () => {
    writeLlmConfig({
      default: {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-roundtrip",
        model: "gpt-4o-mini",
      },
      draft: { model: "gpt-4o", max_tokens: 8000 },
    });
    expect(readLlmConfig()).toEqual({
      default: {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-roundtrip",
        model: "gpt-4o-mini",
      },
      draft: { model: "gpt-4o", max_tokens: 8000 },
    });
  });

  test("writeLlmConfig stores the file at 0600 on POSIX", () => {
    if (platform() === "win32") return; // no POSIX perms to check
    writeLlmConfig({
      default: {
        provider: "p",
        base_url: "https://example.com",
        api_key: "k",
        model: "m",
      },
    });
    const mode = statSync(llmConfigFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("clearLlmConfig removes the file", () => {
    writeLlmConfig({
      default: {
        provider: "p",
        base_url: "https://example.com",
        api_key: "k",
        model: "m",
      },
    });
    expect(existsSync(llmConfigFile())).toBe(true);
    clearLlmConfig();
    expect(existsSync(llmConfigFile())).toBe(false);
    expect(readLlmConfig()).toBeNull();
  });

  test("readLlmConfig returns null on a corrupt file rather than throwing", () => {
    writeFileSync(llmConfigFile(), "not json");
    expect(readLlmConfig()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Secrets roundtrip (loadOrCreateSecrets generates on first call,
// readSecrets reads without creating)
// ---------------------------------------------------------------------------

describe("secrets", () => {
  let scratch: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.ARKEON_WIKI_HOME;
    scratch = mkdtempSync(join(tmpdir(), "arkeon-cli-test-"));
    process.env.ARKEON_WIKI_HOME = scratch;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.ARKEON_WIKI_HOME = prevHome;
    else delete process.env.ARKEON_WIKI_HOME;
    rmSync(scratch, { recursive: true, force: true });
  });

  test("readSecrets returns null before any write", () => {
    expect(readSecrets()).toBeNull();
  });

  test("loadOrCreateSecrets generates + persists on first call", () => {
    const first = loadOrCreateSecrets();
    expect(first.adminBootstrapKey).toMatch(/^ak_[0-9a-f]{64}$/);
    expect(first.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.meiliMasterKey).toMatch(/^[0-9a-f]{48}$/);
    expect(first.pgPassword).toMatch(/^[0-9a-f]+$/);
    expect(existsSync(secretsFile())).toBe(true);
  });

  test("loadOrCreateSecrets returns the same values on subsequent calls", () => {
    const first = loadOrCreateSecrets();
    const second = loadOrCreateSecrets();
    expect(second).toEqual(first);
  });

  test("readSecrets returns the persisted values without side effects", () => {
    const first = loadOrCreateSecrets();
    const read = readSecrets();
    expect(read).toEqual(first);
  });

  test("secrets.json is mode 0600 on POSIX", () => {
    if (platform() === "win32") return;
    loadOrCreateSecrets();
    const mode = statSync(secretsFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("consecutive ARKEON_WIKI_HOME scopes generate independent secret sets", () => {
    const first = loadOrCreateSecrets();
    // Point at a different dir — must not reuse the first one's keys.
    const otherScratch = mkdtempSync(join(tmpdir(), "arkeon-cli-test-"));
    const prev = process.env.ARKEON_WIKI_HOME;
    process.env.ARKEON_WIKI_HOME = otherScratch;
    try {
      const second = loadOrCreateSecrets();
      expect(second.adminBootstrapKey).not.toBe(first.adminBootstrapKey);
      expect(second.pgPassword).not.toBe(first.pgPassword);
    } finally {
      process.env.ARKEON_WIKI_HOME = prev;
      rmSync(otherScratch, { recursive: true, force: true });
    }
  });
});
