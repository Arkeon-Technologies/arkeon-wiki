// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLlmClient, isLlmConfigured, resetLlmCache } from "../../src/server/lib/llm.js";

describe("llm config resolution", () => {
  let scratch: string;
  let prevHome: string | undefined;
  let prevApiKey: string | undefined;
  let prevBaseUrl: string | undefined;
  let prevResolveModel: string | undefined;
  let prevDraftModel: string | undefined;

  beforeEach(() => {
    prevHome = process.env.ARKEON_HOME;
    prevApiKey = process.env.OPENAI_API_KEY;
    prevBaseUrl = process.env.OPENAI_BASE_URL;
    prevResolveModel = process.env.WIKI_RESOLVE_MODEL;
    prevDraftModel = process.env.WIKI_DRAFT_MODEL;
    scratch = mkdtempSync(join(tmpdir(), "arkeon-llm-test-"));
    process.env.ARKEON_HOME = scratch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.WIKI_RESOLVE_MODEL;
    delete process.env.WIKI_DRAFT_MODEL;
    resetLlmCache();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.ARKEON_HOME = prevHome;
    else delete process.env.ARKEON_HOME;
    if (prevApiKey !== undefined) process.env.OPENAI_API_KEY = prevApiKey;
    if (prevBaseUrl !== undefined) process.env.OPENAI_BASE_URL = prevBaseUrl;
    if (prevResolveModel !== undefined) process.env.WIKI_RESOLVE_MODEL = prevResolveModel;
    if (prevDraftModel !== undefined) process.env.WIKI_DRAFT_MODEL = prevDraftModel;
    rmSync(scratch, { recursive: true, force: true });
    resetLlmCache();
  });

  test("throws a descriptive error when no config and no env var", () => {
    expect(() => getLlmClient("resolve")).toThrow(/LLM configuration missing for step "resolve"/);
  });

  test("isLlmConfigured returns false when no config and no env var", () => {
    expect(isLlmConfigured()).toBe(false);
  });

  test("uses OPENAI_API_KEY from env with hardcoded default model per step", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    const resolve = getLlmClient("resolve");
    expect(resolve.model).toBe("gpt-5.4-nano");
    expect(resolve.maxTokens).toBe(256);

    const draft = getLlmClient("draft");
    expect(draft.model).toBe("gpt-5.4-nano");
    expect(draft.maxTokens).toBe(8000);
  });

  test("file default applies to every step and per-step overrides win", () => {
    writeFileSync(
      join(scratch, "llm.json"),
      JSON.stringify({
        default: { api_key: "sk-file", model: "gpt-5.4-nano", max_tokens: 512 },
        draft: { model: "gpt-4o", max_tokens: 8000 },
      }),
    );

    const resolve = getLlmClient("resolve");
    expect(resolve.model).toBe("gpt-5.4-nano");
    expect(resolve.maxTokens).toBe(512);

    const draft = getLlmClient("draft");
    expect(draft.model).toBe("gpt-4o");
    expect(draft.maxTokens).toBe(8000);
  });

  test("per-step env var beats both file and file-default", () => {
    writeFileSync(
      join(scratch, "llm.json"),
      JSON.stringify({
        default: { api_key: "sk-file", model: "gpt-4o-mini" },
        draft: { model: "gpt-4o" },
      }),
    );
    process.env.WIKI_DRAFT_MODEL = "gpt-5-custom";

    const draft = getLlmClient("draft");
    expect(draft.model).toBe("gpt-5-custom");
  });

  test("file-based api_key is used even when env var is unset", () => {
    writeFileSync(
      join(scratch, "llm.json"),
      JSON.stringify({ default: { api_key: "sk-only-in-file", model: "gpt-4o-mini" } }),
    );
    expect(isLlmConfigured()).toBe(true);
    const resolve = getLlmClient("resolve");
    expect(resolve.client).toBeDefined();
  });

  test("notices llm.json when it appears after an initial missing-file check", () => {
    expect(isLlmConfigured()).toBe(false);

    writeFileSync(
      join(scratch, "llm.json"),
      JSON.stringify({ default: { api_key: "sk-created-later", model: "gpt-4o-mini" } }),
    );

    expect(isLlmConfigured()).toBe(true);
    expect(getLlmClient("resolve").model).toBe("gpt-4o-mini");
  });

  test("reloads llm.json when the file changes", () => {
    const path = join(scratch, "llm.json");
    writeFileSync(
      path,
      JSON.stringify({ default: { api_key: "sk-file", model: "gpt-4o-mini" } }),
    );
    expect(getLlmClient("resolve").model).toBe("gpt-4o-mini");

    writeFileSync(
      path,
      JSON.stringify({
        default: { api_key: "sk-file", model: "gpt-4o" },
        resolve: { model: "gpt-5.4-nano", max_tokens: 384 },
      }),
    );

    const resolve = getLlmClient("resolve");
    expect(resolve.model).toBe("gpt-5.4-nano");
    expect(resolve.maxTokens).toBe(384);
  });

  test("step-specific api_key in file overrides default api_key", () => {
    writeFileSync(
      join(scratch, "llm.json"),
      JSON.stringify({
        default: { api_key: "sk-default", model: "gpt-4o-mini" },
        dedup: { api_key: "sk-dedup-provider", base_url: "https://other.example/v1", model: "gpt-4o" },
      }),
    );

    const dedup = getLlmClient("dedup");
    // We can't inspect OpenAI's private state easily — just ensure it resolved
    // without error and picked the dedup model.
    expect(dedup.model).toBe("gpt-4o");
  });
});
