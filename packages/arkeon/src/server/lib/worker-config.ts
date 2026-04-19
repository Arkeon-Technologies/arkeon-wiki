// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker configuration loader.
 *
 * Reads `$ARKEON_WIKI_HOME/workers.yaml` (default `~/.arkeon-wiki/workers.yaml`)
 * and exposes resolved config for each worker. workers.yaml subsumes
 * llm.json — the top-level `llm:` block replaces llm.json's `"default"`.
 * llm.json continues to work as a lower-priority fallback for existing
 * setups.
 *
 * File shape:
 *
 *   llm:
 *     provider: openai
 *     base_url: https://api.openai.com/v1
 *     api_key: sk-...
 *     model: gpt-5.4-nano
 *     max_tokens: 4096
 *
 *   workers:
 *     extractor:
 *       enabled: true
 *       prompt_mode: append
 *       prompt: "Extra domain rules..."
 *       llm:
 *         model: gpt-5.4-nano
 *       steps:
 *         resolve: { model: gpt-5.4-nano, max_tokens: 256 }
 *         exists:  { model: gpt-5.4-nano, max_tokens: 512 }
 *     drafter:
 *       enabled: true
 *       poll_interval: 10s
 *       batch_size: 5
 *       max_depth: 2
 *       llm: { model: gpt-4o, max_tokens: 8000 }
 *     consolidator:
 *       enabled: false
 *       ...
 *     connector:
 *       enabled: false
 *       ...
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

// ── Types ──────────────────────────────────────────────────────────

export interface LlmConfig {
  provider?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  max_tokens?: number;
}

export type PromptMode = "replace" | "prepend" | "append";

export interface PromptConfig {
  prompt_mode?: PromptMode;
  prompt?: string | null;
}

export interface WorkerConfigBase extends PromptConfig {
  enabled?: boolean;
  llm?: LlmConfig;
}

export interface BackgroundWorkerConfig extends WorkerConfigBase {
  poll_interval?: string;
  batch_size?: number;
}

export interface StepConfig extends PromptConfig {
  model?: string;
  max_tokens?: number;
}

export interface ExtractorConfig extends WorkerConfigBase {
  steps?: {
    resolve?: StepConfig;
    exists?: StepConfig;
  };
}

export interface DrafterConfig extends BackgroundWorkerConfig {
  max_depth?: number;
}

// Future worker configs — uncomment when implemented:
// export interface ConsolidatorConfig extends BackgroundWorkerConfig {
//   similarity_threshold?: number;
// }
// export interface ConnectorConfig extends BackgroundWorkerConfig {}

export interface WorkersYaml {
  llm?: LlmConfig;
  workers?: {
    extractor?: ExtractorConfig;
    drafter?: DrafterConfig;
    // Future workers — uncomment when implemented:
    // consolidator?: ConsolidatorConfig;
    // connector?: ConnectorConfig;
  };
}

export type WorkerName = "extractor" | "drafter";

export interface ResolvedWorkerConfig {
  name: WorkerName;
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  llm: LlmConfig & { model: string; max_tokens: number };
  prompt: { mode: PromptMode; text: string | null };
  extra: Record<string, unknown>;
}

// ── Defaults ───────────────────────────────────────────────────────

const WORKER_DEFAULTS: Record<WorkerName, {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  model: string;
  maxTokens: number;
  extra: Record<string, unknown>;
}> = {
  extractor: {
    enabled: true,
    pollIntervalMs: 0, // sync — not a poller
    batchSize: 0,
    model: "gpt-5.4-nano",
    maxTokens: 256,
    extra: {},
  },
  drafter: {
    enabled: true,
    pollIntervalMs: 10_000,
    batchSize: 5,
    model: "gpt-5.4-nano",
    maxTokens: 8000,
    extra: { max_depth: 2 },
  },
};

// ── Validation ─────────────────────────────────────────────────────

const VALID_PROMPT_MODES = new Set(["replace", "prepend", "append"]);

function assertType(value: unknown, expected: string, path: string): void {
  if (expected === "string" && typeof value !== "string") {
    throw new Error(`[worker-config] ${path} must be a string, got ${typeof value}`);
  }
  if (expected === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`[worker-config] ${path} must be a number, got ${JSON.stringify(value)}`);
    }
  }
  if (expected === "boolean" && typeof value !== "boolean") {
    throw new Error(`[worker-config] ${path} must be a boolean, got ${typeof value}`);
  }
}

function validateLlmConfig(obj: Record<string, unknown>, prefix: string): void {
  if (obj.provider !== undefined) assertType(obj.provider, "string", `${prefix}.provider`);
  if (obj.base_url !== undefined) assertType(obj.base_url, "string", `${prefix}.base_url`);
  if (obj.api_key !== undefined) assertType(obj.api_key, "string", `${prefix}.api_key`);
  if (obj.model !== undefined) assertType(obj.model, "string", `${prefix}.model`);
  if (obj.max_tokens !== undefined) assertType(obj.max_tokens, "number", `${prefix}.max_tokens`);
}

function validatePromptConfig(obj: Record<string, unknown>, prefix: string): void {
  if (obj.prompt_mode !== undefined) {
    assertType(obj.prompt_mode, "string", `${prefix}.prompt_mode`);
    if (!VALID_PROMPT_MODES.has(obj.prompt_mode as string)) {
      throw new Error(
        `[worker-config] ${prefix}.prompt_mode must be one of: replace, prepend, append — got "${obj.prompt_mode}"`,
      );
    }
  }
  if (obj.prompt !== undefined && obj.prompt !== null) {
    assertType(obj.prompt, "string", `${prefix}.prompt`);
  }
}

function validateWorkerBlock(obj: unknown, prefix: string): void {
  if (obj === undefined || obj === null) return;
  if (typeof obj !== "object") {
    throw new Error(`[worker-config] ${prefix} must be a mapping, got ${typeof obj}`);
  }
  const w = obj as Record<string, unknown>;
  if (w.enabled !== undefined) assertType(w.enabled, "boolean", `${prefix}.enabled`);
  if (w.poll_interval !== undefined) assertType(w.poll_interval, "string", `${prefix}.poll_interval`);
  if (w.batch_size !== undefined) assertType(w.batch_size, "number", `${prefix}.batch_size`);
  if (w.max_depth !== undefined) assertType(w.max_depth, "number", `${prefix}.max_depth`);
  if (w.similarity_threshold !== undefined) assertType(w.similarity_threshold, "number", `${prefix}.similarity_threshold`);
  if (w.llm !== undefined) {
    if (typeof w.llm !== "object" || w.llm === null) {
      throw new Error(`[worker-config] ${prefix}.llm must be a mapping`);
    }
    validateLlmConfig(w.llm as Record<string, unknown>, `${prefix}.llm`);
  }
  validatePromptConfig(w, prefix);
}

function validateWorkersYaml(raw: Record<string, unknown> | null, filePath: string): WorkersYaml | null {
  if (!raw) return null;

  if (raw.llm !== undefined) {
    if (typeof raw.llm !== "object" || raw.llm === null) {
      throw new Error(`[worker-config] ${filePath}: llm must be a mapping`);
    }
    validateLlmConfig(raw.llm as Record<string, unknown>, "llm");
  }

  if (raw.workers !== undefined) {
    if (typeof raw.workers !== "object" || raw.workers === null) {
      throw new Error(`[worker-config] ${filePath}: workers must be a mapping`);
    }
    const workers = raw.workers as Record<string, unknown>;
    for (const name of ["extractor", "drafter", "consolidator", "connector"]) {
      if (workers[name] !== undefined) {
        validateWorkerBlock(workers[name], `workers.${name}`);
      }
    }
  }

  return raw as unknown as WorkersYaml;
}

// ── YAML loading (mtime-cached) ────────────────────────────────────

function arkeonHome(): string {
  return process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
}

function workersYamlPath(): string {
  return process.env.ARKEON_WORKERS_CONFIG ?? join(arkeonHome(), "workers.yaml");
}

let _yamlCache: {
  value: WorkersYaml | null;
  path: string;
  mtimeMs: number | null;
  size: number | null;
} | null = null;

export function loadWorkersYaml(): WorkersYaml | null {
  const path = workersYamlPath();

  if (!existsSync(path)) {
    if (_yamlCache && _yamlCache.path === path && _yamlCache.mtimeMs === null) {
      return _yamlCache.value;
    }
    _yamlCache = { value: null, path, mtimeMs: null, size: null };
    return null;
  }

  const stat = statSync(path);
  if (
    _yamlCache &&
    _yamlCache.path === path &&
    _yamlCache.mtimeMs === stat.mtimeMs &&
    _yamlCache.size === stat.size
  ) {
    return _yamlCache.value;
  }

  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`[worker-config] invalid YAML in ${path}: ${(err as Error).message}`);
  }

  if (parsed !== null && typeof parsed !== "object") {
    throw new Error(`[worker-config] ${path} must be a YAML mapping, got ${typeof parsed}`);
  }

  const validated = validateWorkersYaml(parsed as Record<string, unknown> | null, path);
  _yamlCache = { value: validated, path, mtimeMs: stat.mtimeMs, size: stat.size };
  return validated;
}

/** For tests: forget cached YAML. */
export function resetWorkerConfigCache(): void {
  _yamlCache = null;
}

// ── Duration parsing ───────────────────────────────────────────────

const DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  if (!match) throw new Error(`Invalid duration: "${s}"`);
  const [, n, unit] = match;
  return Math.round(parseFloat(n!) * DURATION_MULTIPLIERS[unit!]!);
}

// ── Config resolution ──────────────────────────────────────────────

/**
 * Resolve the full config for a worker by merging:
 *   workers.yaml worker block > workers.yaml global llm > hardcoded defaults
 */
export function resolveWorkerConfig(name: WorkerName, yamlConfig?: WorkersYaml | null): ResolvedWorkerConfig {
  const cfg = yamlConfig ?? loadWorkersYaml();
  const defaults = WORKER_DEFAULTS[name];
  const workerCfg = cfg?.workers?.[name] as WorkerConfigBase & BackgroundWorkerConfig & Record<string, unknown> | undefined;
  const globalLlm = cfg?.llm ?? {};

  // Enabled
  const enabled = workerCfg?.enabled ?? defaults.enabled;

  // Poll interval
  let pollIntervalMs = defaults.pollIntervalMs;
  if (workerCfg?.poll_interval) {
    pollIntervalMs = parseDuration(workerCfg.poll_interval);
  }

  // Batch size
  const batchSize = workerCfg?.batch_size ?? defaults.batchSize;

  // LLM: worker llm > global llm > defaults
  const workerLlm = workerCfg?.llm ?? {};
  const llm: ResolvedWorkerConfig["llm"] = {
    provider: workerLlm.provider ?? globalLlm.provider,
    base_url: workerLlm.base_url ?? globalLlm.base_url,
    api_key: workerLlm.api_key ?? globalLlm.api_key,
    model: workerLlm.model ?? globalLlm.model ?? defaults.model,
    max_tokens: workerLlm.max_tokens ?? globalLlm.max_tokens ?? defaults.maxTokens,
  };

  // Prompt
  const prompt: ResolvedWorkerConfig["prompt"] = {
    mode: workerCfg?.prompt_mode ?? "append",
    text: workerCfg?.prompt ?? null,
  };

  // Extra (worker-specific settings)
  const extra: Record<string, unknown> = { ...defaults.extra };
  if (name === "drafter" && (workerCfg as DrafterConfig)?.max_depth !== undefined) {
    extra.max_depth = (workerCfg as DrafterConfig).max_depth;
  }

  return { name, enabled, pollIntervalMs, batchSize, llm, prompt, extra };
}

// ── Prompt building ────────────────────────────────────────────────

/**
 * Merge a built-in prompt with user-configured prompt text according
 * to the prompt mode.
 *
 * - replace: user text fully replaces built-in (if user text is set)
 * - prepend: user text goes before built-in
 * - append:  user text goes after built-in
 * - null/undefined user text: always returns built-in unchanged
 */
export function buildPrompt(builtIn: string, config: ResolvedWorkerConfig["prompt"]): string {
  if (!config.text) return builtIn;
  switch (config.mode) {
    case "prepend": return `${config.text}\n\n${builtIn}`;
    case "append": return `${builtIn}\n\n${config.text}`;
    case "replace": return config.text;
  }
}

// ── LLM config for llm.ts integration ──────────────────────────────

/** Map LLM step names to their parent worker. */
const STEP_TO_WORKER: Record<string, WorkerName> = {
  resolve: "extractor",
  exists: "extractor",
  draft: "drafter",
  // Future: dedup → consolidator, connect → connector
};

/**
 * Get the LLM config for a given pipeline step from workers.yaml.
 * Returns partial config — the caller (llm.ts) merges this with
 * its own fallback chain (llm.json > env > hardcoded).
 *
 * For the extractor, also checks `workers.extractor.steps.<step>`
 * for step-level overrides.
 */
export function getWorkerLlmConfig(step: string): Partial<LlmConfig> | null {
  const workerName = STEP_TO_WORKER[step];
  if (!workerName) return null;

  const cfg = loadWorkersYaml();
  if (!cfg) return null;

  const globalLlm = cfg.llm ?? {};
  const workerCfg = cfg.workers?.[workerName] as WorkerConfigBase & Record<string, unknown> | undefined;
  const workerLlm = workerCfg?.llm ?? {};

  // For extractor, check step-level config
  let stepLlm: Partial<LlmConfig> = {};
  if (workerName === "extractor") {
    const extCfg = workerCfg as ExtractorConfig | undefined;
    const stepCfg = extCfg?.steps?.[step as "resolve" | "exists"];
    if (stepCfg) {
      stepLlm = {
        model: stepCfg.model,
        max_tokens: stepCfg.max_tokens,
      };
    }
  }

  // Merge: step > worker > global (only non-undefined values)
  const merged: Partial<LlmConfig> = {};
  for (const key of ["provider", "base_url", "api_key", "model", "max_tokens"] as const) {
    const val = stepLlm[key] ?? workerLlm[key] ?? globalLlm[key];
    if (val !== undefined) {
      (merged as Record<string, unknown>)[key] = val;
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Get the prompt config for a given pipeline step from workers.yaml.
 * For extractor steps, checks step-level prompt config first, then
 * falls back to the extractor worker-level prompt config.
 */
export function getWorkerPromptConfig(step: string): ResolvedWorkerConfig["prompt"] | null {
  const workerName = STEP_TO_WORKER[step];
  if (!workerName) return null;

  const cfg = loadWorkersYaml();
  if (!cfg) return null;

  const workerCfg = cfg.workers?.[workerName] as WorkerConfigBase & Record<string, unknown> | undefined;
  if (!workerCfg) return null;

  // For extractor, check step-level prompt first
  if (workerName === "extractor") {
    const extCfg = workerCfg as ExtractorConfig;
    const stepCfg = extCfg.steps?.[step as "resolve" | "exists"];
    if (stepCfg?.prompt) {
      return { mode: stepCfg.prompt_mode ?? "append", text: stepCfg.prompt };
    }
  }

  // Worker-level prompt
  if (workerCfg.prompt) {
    return { mode: workerCfg.prompt_mode ?? "append", text: workerCfg.prompt };
  }

  return null;
}
