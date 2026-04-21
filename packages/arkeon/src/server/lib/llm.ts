// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM client registry for wiki pipeline steps.
 *
 * Each step (resolve, exists, draft, dedup) can use a different model.
 * Configuration layers, highest priority first:
 *
 *   1. Per-step env vars: WIKI_RESOLVE_MODEL, WIKI_EXISTS_MODEL,
 *      WIKI_DRAFT_MODEL, WIKI_DEDUP_MODEL (model only)
 *   2. workers.yaml step/worker/global LLM config
 *   3. Step block in $ARKEON_WIKI_HOME/llm.json (or WIKI_LLM_CONFIG_PATH)
 *   4. Default block in the same file
 *   5. Base env vars: OPENAI_API_KEY, OPENAI_BASE_URL (for api_key + base_url)
 *   6. Hardcoded defaults per step (cheap models for resolve/exists,
 *      stronger models for draft/dedup)
 *
 * workers.yaml is the primary config surface and subsumes llm.json.
 * llm.json continues to work as a lower-priority fallback.
 */

import OpenAI from "openai";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectLlmConfig } from "../../shared/llm-detect.js";
import { getWorkerLlmConfig } from "./worker-config.js";

export type LlmStep = "resolve" | "exists" | "draft" | "dedup" | "enrich";

export interface LlmStepConfig {
  /** Informational label — "openai", "anthropic-via-openrouter", etc. */
  provider?: string;
  /** OpenAI-compatible base URL. Omit to use openai package default. */
  base_url?: string;
  /** API key for the provider. */
  api_key?: string;
  /** Model identifier. Required once resolved. */
  model: string;
  /** Max output tokens for this step. */
  max_tokens?: number;
}

export interface LlmConfigFile {
  default?: Partial<LlmStepConfig>;
  resolve?: Partial<LlmStepConfig>;
  exists?: Partial<LlmStepConfig>;
  draft?: Partial<LlmStepConfig>;
  dedup?: Partial<LlmStepConfig>;
  enrich?: Partial<LlmStepConfig>;
}

export interface ResolvedLlm {
  client: OpenAI;
  model: string;
  maxTokens: number;
  /** Which step this client was resolved for (for logging). */
  step: LlmStep;
}

// Nano is the universal default — cheap, fast, good enough for multi-choice
// judgment and tightly-scoped drafting. Override per step via llm.json (or
// WIKI_DRAFT_MODEL / WIKI_DEDUP_MODEL env vars) if you want stronger models
// for draft and dedup.
const DEFAULT_MODEL: Record<LlmStep, string> = {
  resolve: "gpt-5.4-nano",
  exists: "gpt-5.4-nano",
  draft: "gpt-5.4-nano",
  dedup: "gpt-5.4-nano",
  enrich: "gpt-5.4-nano",
};

const DEFAULT_MAX_TOKENS: Record<LlmStep, number> = {
  resolve: 256,
  exists: 512,
  draft: 8000,
  dedup: 16000,
  enrich: 8000,
};

function arkeonHome(): string {
  return process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
}

function configPath(): string {
  return process.env.WIKI_LLM_CONFIG_PATH ?? join(arkeonHome(), "llm.json");
}

let _fileCache: {
  value: LlmConfigFile | null;
  path: string;
  mtimeMs: number | null;
  size: number | null;
} | null = null;

function loadConfigFile(): LlmConfigFile | null {
  const path = configPath();

  if (!existsSync(path)) {
    if (_fileCache && _fileCache.path === path && _fileCache.mtimeMs === null) {
      return _fileCache.value;
    }
    _fileCache = { value: null, path, mtimeMs: null, size: null };
    return null;
  }

  const stat = statSync(path);
  if (
    _fileCache &&
    _fileCache.path === path &&
    _fileCache.mtimeMs === stat.mtimeMs &&
    _fileCache.size === stat.size
  ) {
    return _fileCache.value;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as LlmConfigFile;
    _fileCache = { value: parsed, path, mtimeMs: stat.mtimeMs, size: stat.size };
    return parsed;
  } catch (err) {
    console.warn(`[llm] failed to parse ${path}:`, (err as Error).message);
    _fileCache = { value: null, path, mtimeMs: stat.mtimeMs, size: stat.size };
    return null;
  }
}

/** For tests: forget cached file + clients. */
export function resetLlmCache(): void {
  _fileCache = null;
  _clientCache.clear();
}

const _clientCache = new Map<string, ResolvedLlm>();

/**
 * Resolve an LLM client for a given pipeline step. The returned client,
 * model, and maxTokens reflect the merged configuration for that step.
 *
 * Throws if no api_key can be resolved from any source.
 */
export function getLlmClient(step: LlmStep): ResolvedLlm {
  // workers.yaml config (step > worker > global)
  const workerLlm = getWorkerLlmConfig(step) ?? {};

  // llm.json fallback
  const file = loadConfigFile();
  const fileDefault = file?.default ?? {};
  const fileStep = file?.[step] ?? {};

  // Step-specific model env var wins over everything except explicit
  // workers.yaml settings. No per-step base_url/api_key env vars —
  // if you need different providers per step, use workers.yaml.
  const envStepModel = process.env[`WIKI_${step.toUpperCase()}_MODEL`];
  const envApiKey = process.env.OPENAI_API_KEY;
  const envBaseUrl = process.env.OPENAI_BASE_URL;

  // Resolution chain: env step model > workers.yaml > llm.json step > llm.json default > env > hardcoded
  const apiKey = workerLlm.api_key ?? fileStep.api_key ?? fileDefault.api_key ?? envApiKey;
  const baseUrl = workerLlm.base_url ?? fileStep.base_url ?? fileDefault.base_url ?? envBaseUrl;
  const model = envStepModel ?? workerLlm.model ?? fileStep.model ?? fileDefault.model ?? DEFAULT_MODEL[step];
  const maxTokens = workerLlm.max_tokens ?? fileStep.max_tokens ?? fileDefault.max_tokens ?? DEFAULT_MAX_TOKENS[step];

  if (!apiKey) {
    throw new Error(
      `LLM configuration missing for step "${step}". Set OPENAI_API_KEY in ` +
      `the environment, write ${configPath()} with a default.api_key, or ` +
      `configure it in workers.yaml.`,
    );
  }

  const cacheKey = `${apiKey}:${baseUrl ?? ""}:${model}:${maxTokens}`;
  const cached = _clientCache.get(cacheKey);
  if (cached) return { ...cached, step };

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl || undefined,
  });
  const resolved: ResolvedLlm = { client, model, maxTokens, step };
  _clientCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * True if any LLM configuration can be resolved. Lets the route layer
 * decide whether to reject requests that require LLM calls (e.g. a
 * wiki with [[resolve:...]] links) rather than 500 deep in the pipeline.
 *
 * Delegates to the shared detection module so CLI and server agree on
 * what "configured" means.
 */
export function isLlmConfigured(): boolean {
  return detectLlmConfig().configured;
}
