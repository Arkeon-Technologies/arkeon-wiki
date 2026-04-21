// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM configuration detection — shared between CLI and server.
 *
 * This module only reads files and env vars; it does NOT import OpenAI
 * or any heavy server dependencies, so the CLI can safely use it without
 * pulling in the server dependency tree.
 *
 * Detection mirrors the server's resolution chain:
 *   workers.yaml (step > worker > global) > llm.json (step > default) > OPENAI_API_KEY env
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

export interface LlmDetectResult {
  configured: boolean;
  source: "workers.yaml" | "llm.json" | "OPENAI_API_KEY" | null;
  model: string | null;
}

function arkeonHome(): string {
  return process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
}

function workersYamlPath(): string {
  return process.env.ARKEON_WORKERS_CONFIG ?? join(arkeonHome(), "workers.yaml");
}

function llmJsonPath(): string {
  return process.env.WIKI_LLM_CONFIG_PATH ?? join(arkeonHome(), "llm.json");
}

/**
 * Check whether any LLM API key is configured, and if so, where it
 * comes from and what model is set. Checks all layers of the config
 * stack (workers.yaml step/worker/global, llm.json step/default, env).
 */
export function detectLlmConfig(): LlmDetectResult {
  // ── workers.yaml ──────────────────────────────────────────────
  const wPath = workersYamlPath();
  if (existsSync(wPath)) {
    try {
      const doc = yaml.load(readFileSync(wPath, "utf-8")) as Record<string, unknown> | null;
      if (doc) {
        const globalLlm = (doc.llm ?? {}) as Record<string, unknown>;
        const workers = (doc.workers ?? {}) as Record<string, unknown>;

        // Check step-level and worker-level api_key in each worker
        for (const name of ["extractor", "drafter", "consolidator", "connector"]) {
          const w = workers[name] as Record<string, unknown> | undefined;
          if (!w) continue;

          // Step-level (extractor only: steps.resolve, steps.exists)
          const steps = w.steps as Record<string, Record<string, unknown>> | undefined;
          if (steps) {
            for (const step of Object.values(steps)) {
              if (step?.api_key) {
                return { configured: true, source: "workers.yaml", model: (step.model as string) ?? null };
              }
            }
          }

          // Worker-level llm block
          const wLlm = w.llm as Record<string, unknown> | undefined;
          if (wLlm?.api_key) {
            return { configured: true, source: "workers.yaml", model: (wLlm.model as string) ?? null };
          }
        }

        // Global-level llm block
        if (globalLlm.api_key) {
          return { configured: true, source: "workers.yaml", model: (globalLlm.model as string) ?? null };
        }
      }
    } catch { /* malformed yaml — fall through */ }
  }

  // ── llm.json ──────────────────────────────────────────────────
  const lPath = llmJsonPath();
  if (existsSync(lPath)) {
    try {
      const doc = JSON.parse(readFileSync(lPath, "utf-8")) as Record<string, unknown>;
      // Check step-level keys first, then default
      for (const key of ["resolve", "exists", "draft", "dedup", "default"]) {
        const block = doc[key] as Record<string, unknown> | undefined;
        if (block?.api_key) {
          return { configured: true, source: "llm.json", model: (block.model as string) ?? null };
        }
      }
    } catch { /* malformed json — fall through */ }
  }

  // ── Environment variable ──────────────────────────────────────
  if (process.env.OPENAI_API_KEY) {
    return { configured: true, source: "OPENAI_API_KEY", model: null };
  }

  return { configured: false, source: null, model: null };
}
