// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseDuration,
  buildPrompt,
  resolveWorkerConfig,
  loadWorkersYaml,
  resetWorkerConfigCache,
  getWorkerLlmConfig,
  getWorkerPromptConfig,
} from "../../src/server/lib/worker-config.js";

// ── parseDuration ──────────────────────────────────────────────────

describe("parseDuration", () => {
  test("parses milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  test("parses seconds", () => {
    expect(parseDuration("10s")).toBe(10_000);
  });

  test("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  test("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  test("parses fractional values", () => {
    expect(parseDuration("1.5s")).toBe(1500);
    expect(parseDuration("0.5m")).toBe(30_000);
  });

  test("throws on invalid format", () => {
    expect(() => parseDuration("five")).toThrow('Invalid duration: "five"');
    expect(() => parseDuration("10")).toThrow('Invalid duration: "10"');
    expect(() => parseDuration("10d")).toThrow('Invalid duration: "10d"');
    expect(() => parseDuration("")).toThrow('Invalid duration: ""');
  });
});

// ── buildPrompt ────────────────────────────────────────────────────

describe("buildPrompt", () => {
  const BUILTIN = "You are a judge.";

  test("returns built-in when text is null", () => {
    expect(buildPrompt(BUILTIN, { mode: "append", text: null })).toBe(BUILTIN);
  });

  test("returns built-in when text is empty string", () => {
    expect(buildPrompt(BUILTIN, { mode: "append", text: "" })).toBe(BUILTIN);
  });

  test("append mode adds text after built-in", () => {
    const result = buildPrompt(BUILTIN, { mode: "append", text: "Extra rule." });
    expect(result).toBe("You are a judge.\n\nExtra rule.");
  });

  test("prepend mode adds text before built-in", () => {
    const result = buildPrompt(BUILTIN, { mode: "prepend", text: "Important:" });
    expect(result).toBe("Important:\n\nYou are a judge.");
  });

  test("replace mode fully replaces built-in", () => {
    const result = buildPrompt(BUILTIN, { mode: "replace", text: "Custom prompt." });
    expect(result).toBe("Custom prompt.");
  });
});

// ── resolveWorkerConfig ────────────────────────────────────────────

describe("resolveWorkerConfig", () => {
  test("returns hardcoded defaults when no yaml is provided", () => {
    const cfg = resolveWorkerConfig("drafter", null);
    expect(cfg.name).toBe("drafter");
    expect(cfg.enabled).toBe(true);
    expect(cfg.pollIntervalMs).toBe(10_000);
    expect(cfg.batchSize).toBe(5);
    expect(cfg.llm.model).toBe("gpt-5.4-nano");
    expect(cfg.llm.max_tokens).toBe(8000);
    expect(cfg.extra.max_depth).toBe(2);
  });

  test("extractor defaults are sync (pollIntervalMs = 0)", () => {
    const cfg = resolveWorkerConfig("extractor", null);
    expect(cfg.pollIntervalMs).toBe(0);
    expect(cfg.enabled).toBe(true);
  });

  test("prompt_mode defaults to append", () => {
    const cfg = resolveWorkerConfig("drafter", null);
    expect(cfg.prompt.mode).toBe("append");
    expect(cfg.prompt.text).toBeNull();
  });

  test("yaml worker block overrides defaults", () => {
    const cfg = resolveWorkerConfig("drafter", {
      workers: {
        drafter: {
          enabled: false,
          poll_interval: "30s",
          batch_size: 10,
          max_depth: 5,
          llm: { model: "gpt-4o", max_tokens: 16000 },
          prompt_mode: "replace",
          prompt: "Custom drafter prompt.",
        },
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.pollIntervalMs).toBe(30_000);
    expect(cfg.batchSize).toBe(10);
    expect(cfg.extra.max_depth).toBe(5);
    expect(cfg.llm.model).toBe("gpt-4o");
    expect(cfg.llm.max_tokens).toBe(16000);
    expect(cfg.prompt.mode).toBe("replace");
    expect(cfg.prompt.text).toBe("Custom drafter prompt.");
  });

  test("global llm block applies when worker llm is absent", () => {
    const cfg = resolveWorkerConfig("drafter", {
      llm: { api_key: "sk-global", model: "gpt-4o-mini" },
    });
    expect(cfg.llm.api_key).toBe("sk-global");
    expect(cfg.llm.model).toBe("gpt-4o-mini");
  });

  test("worker llm overrides global llm", () => {
    const cfg = resolveWorkerConfig("drafter", {
      llm: { api_key: "sk-global", model: "gpt-4o-mini" },
      workers: {
        drafter: {
          llm: { model: "gpt-4o", api_key: "sk-drafter" },
        },
      },
    });
    expect(cfg.llm.api_key).toBe("sk-drafter");
    expect(cfg.llm.model).toBe("gpt-4o");
  });
});

// ── YAML loading + validation ──────────────────────────────────────

describe("loadWorkersYaml", () => {
  let scratch: string;
  let prevHome: string | undefined;
  let prevConfig: string | undefined;

  beforeEach(() => {
    prevHome = process.env.ARKEON_WIKI_HOME;
    prevConfig = process.env.ARKEON_WORKERS_CONFIG;
    scratch = mkdtempSync(join(tmpdir(), "arkeon-worker-cfg-"));
    process.env.ARKEON_WIKI_HOME = scratch;
    delete process.env.ARKEON_WORKERS_CONFIG;
    resetWorkerConfigCache();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.ARKEON_WIKI_HOME = prevHome;
    else delete process.env.ARKEON_WIKI_HOME;
    if (prevConfig !== undefined) process.env.ARKEON_WORKERS_CONFIG = prevConfig;
    else delete process.env.ARKEON_WORKERS_CONFIG;
    rmSync(scratch, { recursive: true, force: true });
    resetWorkerConfigCache();
  });

  test("returns null when file does not exist", () => {
    expect(loadWorkersYaml()).toBeNull();
  });

  test("loads a valid workers.yaml", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "llm:\n  api_key: sk-test\n  model: gpt-4o\n",
    );
    const cfg = loadWorkersYaml();
    expect(cfg?.llm?.api_key).toBe("sk-test");
    expect(cfg?.llm?.model).toBe("gpt-4o");
  });

  test("throws on malformed YAML syntax", () => {
    writeFileSync(join(scratch, "workers.yaml"), "{{not yaml");
    expect(() => loadWorkersYaml()).toThrow(/invalid YAML/);
  });

  test("throws when batch_size is not a number", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "workers:\n  drafter:\n    batch_size: five\n",
    );
    expect(() => loadWorkersYaml()).toThrow(/batch_size must be a number/);
  });

  test("throws when enabled is not a boolean", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "workers:\n  extractor:\n    enabled: yes_please\n",
    );
    expect(() => loadWorkersYaml()).toThrow(/enabled must be a boolean/);
  });

  test("throws when prompt_mode is invalid", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "workers:\n  drafter:\n    prompt_mode: merge\n",
    );
    expect(() => loadWorkersYaml()).toThrow(/prompt_mode must be one of/);
  });

  test("throws when llm.max_tokens is not a number", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "llm:\n  max_tokens: lots\n",
    );
    expect(() => loadWorkersYaml()).toThrow(/max_tokens must be a number/);
  });
});

// ── getWorkerLlmConfig ─────────────────────────────────────────────

describe("getWorkerLlmConfig", () => {
  let scratch: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.ARKEON_WIKI_HOME;
    scratch = mkdtempSync(join(tmpdir(), "arkeon-wlc-"));
    process.env.ARKEON_WIKI_HOME = scratch;
    resetWorkerConfigCache();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.ARKEON_WIKI_HOME = prevHome;
    else delete process.env.ARKEON_WIKI_HOME;
    rmSync(scratch, { recursive: true, force: true });
    resetWorkerConfigCache();
  });

  test("returns null for unknown step", () => {
    expect(getWorkerLlmConfig("unknown")).toBeNull();
  });

  test("returns null when no workers.yaml exists", () => {
    expect(getWorkerLlmConfig("resolve")).toBeNull();
  });

  test("returns global llm config for known step", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "llm:\n  api_key: sk-g\n  model: gpt-4o\n",
    );
    const cfg = getWorkerLlmConfig("resolve");
    expect(cfg?.api_key).toBe("sk-g");
    expect(cfg?.model).toBe("gpt-4o");
  });

  test("extractor step config overrides worker config", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      [
        "workers:",
        "  extractor:",
        "    llm:",
        "      model: gpt-4o",
        "    steps:",
        "      resolve:",
        "        model: gpt-5.4-nano",
        "        max_tokens: 128",
      ].join("\n"),
    );
    const cfg = getWorkerLlmConfig("resolve");
    expect(cfg?.model).toBe("gpt-5.4-nano");
    expect(cfg?.max_tokens).toBe(128);
  });
});

// ── getWorkerPromptConfig ──────────────────────────────────────────

describe("getWorkerPromptConfig", () => {
  let scratch: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.ARKEON_WIKI_HOME;
    scratch = mkdtempSync(join(tmpdir(), "arkeon-wpc-"));
    process.env.ARKEON_WIKI_HOME = scratch;
    resetWorkerConfigCache();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.ARKEON_WIKI_HOME = prevHome;
    else delete process.env.ARKEON_WIKI_HOME;
    rmSync(scratch, { recursive: true, force: true });
    resetWorkerConfigCache();
  });

  test("returns null when no workers.yaml", () => {
    expect(getWorkerPromptConfig("resolve")).toBeNull();
  });

  test("returns worker-level prompt config", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "workers:\n  drafter:\n    prompt: Custom draft rules.\n    prompt_mode: replace\n",
    );
    const cfg = getWorkerPromptConfig("draft");
    expect(cfg?.text).toBe("Custom draft rules.");
    expect(cfg?.mode).toBe("replace");
  });

  test("defaults prompt_mode to append", () => {
    writeFileSync(
      join(scratch, "workers.yaml"),
      "workers:\n  extractor:\n    prompt: Extra rules.\n",
    );
    const cfg = getWorkerPromptConfig("resolve");
    expect(cfg?.mode).toBe("append");
    expect(cfg?.text).toBe("Extra rules.");
  });
});
