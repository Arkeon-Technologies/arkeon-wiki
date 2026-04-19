// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the `arkeon init` / `up` / `down` flow that don't
 * need to touch the filesystem, spawn processes, or know about the
 * embedded-stack internals.
 *
 * Everything here is unit-testable without a working Arkeon install.
 * Secrets, pidfiles, and the Meilisearch + Postgres lifecycle live in
 * `local-runtime.ts`; this file is the narrow surface the command
 * handlers and tests import directly.
 */

import type { LlmConfig } from "./local-runtime.js";

// ---------------------------------------------------------------------------
// .env parser (still useful for reading user-supplied .env files in
// external-services mode; we no longer render a .env ourselves)
// ---------------------------------------------------------------------------

/**
 * Parse a .env-style file into a flat map. Handles:
 *   - blank lines and `# comments` (skipped)
 *   - `KEY=value` and `KEY="value"` (quotes stripped)
 *   - lines without `=` (skipped, with no error)
 *
 * Intentionally minimal — no variable expansion, no escape sequences,
 * no export prefix handling. For anything more sophisticated the CLI
 * should shell to `dotenv/config`.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM flag handling (shared by `arkeon init`)
// ---------------------------------------------------------------------------

/** Raw commander options for the --llm-* flags on `arkeon init`. */
export interface InitLlmFlags {
  llmProvider?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
}

/**
 * Build an LlmConfig with just a `default` block populated from the CLI
 * flags, or null if the caller passed no LLM flags at all. Partial flag
 * sets are an error — either all four of provider/base_url/api_key/model
 * or none. We deliberately do not prompt interactively; `arkeon init`
 * assumes a non-interactive caller (deployment script or LLM agent).
 *
 * Per-step overrides (resolve/exists/draft/dedup) are set by hand-editing
 * ~/.arkeon-wiki/llm.json after init — see docs/dev/WIKI_PIPELINE.md.
 *
 * Throws Error with a message naming the missing flags on partial input,
 * or naming the offending URL on base-URL validation failure.
 */
export function buildLlmConfigFromFlags(flags: InitLlmFlags): LlmConfig | null {
  const { llmProvider, llmBaseUrl, llmApiKey, llmModel } = flags;
  const provided = [llmProvider, llmBaseUrl, llmApiKey, llmModel].filter(
    (v): v is string => Boolean(v),
  );

  if (provided.length === 0) {
    return null;
  }
  if (provided.length < 4) {
    const missing: string[] = [];
    if (!llmProvider) missing.push("--llm-provider");
    if (!llmBaseUrl) missing.push("--llm-base-url");
    if (!llmApiKey) missing.push("--llm-api-key");
    if (!llmModel) missing.push("--llm-model");
    throw new Error(
      `Partial LLM config — all four of --llm-provider, --llm-base-url, --llm-api-key, --llm-model must be provided together. Missing: ${missing.join(", ")}.`,
    );
  }

  // URL sanity check — catch typos before the value gets persisted.
  try {
    // eslint-disable-next-line no-new
    new URL(llmBaseUrl!);
  } catch {
    throw new Error(`--llm-base-url "${llmBaseUrl}" is not a valid URL.`);
  }

  return {
    default: {
      provider: llmProvider!,
      base_url: llmBaseUrl!,
      api_key: llmApiKey!,
      model: llmModel!,
    },
  };
}
