// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Declarative agent configuration loaded from YAML.
 *
 * Two locations, both optional:
 *   - $SPACE_DIR/.arkeon/agents.yaml   per-repo, COMMITTED
 *   - ~/.arkeon-wiki/agents.yaml        per-user, machine-local
 *
 * Per-repo wins over user-global. Field-level merge for `defaults`,
 * per-role override for entries under `roles`. Secrets never appear
 * in YAML — `api_key_env` names which env var to read.
 *
 * The YAML is the *source of truth* for what providers/models a role
 * uses, what tools it can call, what its prompts say, and the
 * operator-supplied focus/style instructions. Built-in templates in
 * builtins.ts cover the workflow + tool-use patterns; YAML tunes the
 * knobs operators care about.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────────

export const ROLE_CONFIG_SCHEMA = z.object({
  // Model selection
  provider: z.enum(["openai", "anthropic", "openai-compatible"]).optional(),
  model: z.string().optional(),
  api_key_env: z.string().optional(),
  base_url: z.string().optional(),

  // Tools the LLM may call (names from ALL_TOOLS in tools.ts)
  tools: z.array(z.string()).optional(),

  // Loop bound
  max_steps: z.number().int().positive().max(100).optional(),

  // Prompts
  /** Full system prompt. Replaces the built-in template entirely. */
  system: z.string().optional(),
  /** User-message template. Variables: {{trigger_path}}, {{trigger_entity_id}},
   *  {{space_id}}, {{space_name}}. */
  user: z.string().optional(),
  /** Operator notes appended to the system prompt (built-in or custom).
   *  Use this for focus/style/scope guidance without rewriting the workflow. */
  instructions: z.string().optional(),
});

export const AGENT_CONFIG_SCHEMA = z.object({
  /** Inherited by every role. */
  defaults: ROLE_CONFIG_SCHEMA.optional(),
  /** Per-role overrides (built-in roles) and user-defined roles.
   *  Map keys are role names. */
  roles: z.record(z.string(), ROLE_CONFIG_SCHEMA).optional(),
});

export type RoleConfig = z.infer<typeof ROLE_CONFIG_SCHEMA>;
export type AgentConfig = z.infer<typeof AGENT_CONFIG_SCHEMA>;

// ── Loader ────────────────────────────────────────────────────────

const REPO_RELATIVE_PATH = join(".arkeon", "agents.yaml");
const USER_GLOBAL_PATH = join(homedir(), ".arkeon-wiki", "agents.yaml");

export interface LoadAgentConfigOptions {
  /** The space's watch_dir. The repo-local config is at
   *  {spaceDir}/.arkeon/agents.yaml. */
  spaceDir?: string;
  /** Override the user-global path (mainly for tests). */
  userGlobalPath?: string;
}

/**
 * Load and merge agent config from user-global and repo-local YAML.
 * Either or both may be missing — always returns a valid (possibly
 * empty) AgentConfig.
 */
export function loadAgentConfig(opts: LoadAgentConfigOptions = {}): AgentConfig {
  const userGlobalPath = opts.userGlobalPath ?? USER_GLOBAL_PATH;
  const repoLocalPath = opts.spaceDir
    ? join(opts.spaceDir, REPO_RELATIVE_PATH)
    : null;

  const userGlobal = readConfigFile(userGlobalPath);
  const repoLocal = repoLocalPath ? readConfigFile(repoLocalPath) : {};

  return mergeConfigs(userGlobal, repoLocal);
}

function readConfigFile(path: string): AgentConfig {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agents.yaml at ${path} is not valid YAML: ${msg}`);
  }
  if (parsed === null || parsed === undefined) return {};
  return AGENT_CONFIG_SCHEMA.parse(parsed);
}

/**
 * Merge two configs: `b` (repo-local) overrides `a` (user-global).
 * - `defaults`: field-level shallow merge.
 * - `roles`: per-role replacement (a role from `b` replaces `a`'s entry
 *   wholesale, rather than merging field by field). Keeps the model
 *   simple — to inherit, copy.
 */
export function mergeConfigs(a: AgentConfig, b: AgentConfig): AgentConfig {
  return {
    defaults: { ...a.defaults, ...b.defaults },
    roles: { ...a.roles, ...b.roles },
  };
}
