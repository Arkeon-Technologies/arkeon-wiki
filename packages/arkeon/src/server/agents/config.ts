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

/**
 * One stage of a multi-phase agent run. The runtime loops over phases
 * in order, preserving conversation history across boundaries — so
 * phase 2 sees every tool call and result from phase 1. Between
 * phases the runtime appends the next phase's `prompt` as a new user
 * message and (optionally) swaps the model.
 *
 * Per-phase overrides default to the role-level value. Same-provider
 * model swaps only — cross-provider tool-call format translation is
 * out of scope for now.
 */
export const PHASE_CONFIG_SCHEMA = z.object({
  /** Optional name, surfaced in logs and traces. */
  name: z.string().optional(),
  /** User-message template added to the conversation when this phase
   *  starts. Variables: {{trigger_path}}, {{trigger_entity_id}},
   *  {{space_id}}, {{space_name}}. The first phase's prompt is the
   *  initial user message; subsequent phase prompts are appended. */
  prompt: z.string(),
  /** Override the role-level model for this phase only (e.g. cheap
   *  model for context-gathering, strong model for writing). Same
   *  provider as the role. */
  model: z.string().optional(),
  /** Override the role-level tool whitelist. */
  tools: z.array(z.string()).optional(),
  /** Per-phase step budget. Defaults to the role-level max_steps. */
  max_steps: z.number().int().positive().max(100).optional(),
});

export const ROLE_CONFIG_SCHEMA = z.object({
  // Model selection
  provider: z.enum(["openai", "anthropic", "openai-compatible"]).optional(),
  model: z.string().optional(),
  api_key_env: z.string().optional(),
  base_url: z.string().optional(),

  // Tools the LLM may call (names from ALL_TOOLS in tools.ts)
  tools: z.array(z.string()).optional(),

  // Loop bound (also the default per-phase budget)
  max_steps: z.number().int().positive().max(100).optional(),

  // Prompts
  /** Full system prompt. Replaces the built-in template entirely. */
  system: z.string().optional(),
  /** User-message template — single-phase shape. Variables:
   *  {{trigger_path}}, {{trigger_entity_id}}, {{space_id}}, {{space_name}}.
   *  Mutually exclusive with `phases`: a role uses one or the other. */
  user: z.string().optional(),
  /** Operator notes appended to the system prompt (built-in or custom).
   *  Use this for focus/style/scope guidance without rewriting the workflow. */
  instructions: z.string().optional(),

  /** Multi-phase shape. The runtime walks phases in order in a single
   *  conversation (history preserved across boundaries). Mutually
   *  exclusive with `user` — if both are present `phases` wins and
   *  `user` is ignored. */
  phases: z.array(PHASE_CONFIG_SCHEMA).optional(),

  /** Per-phase model overrides keyed by phase.name. Lets agents.yaml
   *  swap the model used for each phase without re-supplying the
   *  builtin's phase prompts:
   *    roles:
   *      ingestor:
   *        phase_models:
   *          gather: gpt-5.4-mini
   *          write:  gpt-5.4
   *  Layers like `defaults`: defaults < builtin < role. Same-provider
   *  swaps only — cross-provider tool-call format translation is out
   *  of scope. Unknown phase names are ignored but trigger a console
   *  warning at role-build time so typos are visible. */
  phase_models: z.record(z.string(), z.string()).optional(),
});

export const AGENT_CONFIG_SCHEMA = z.object({
  /** Inherited by every role. */
  defaults: ROLE_CONFIG_SCHEMA.optional(),
  /** Per-role overrides (built-in roles) and user-defined roles.
   *  Map keys are role names. */
  roles: z.record(z.string(), ROLE_CONFIG_SCHEMA).optional(),
});

export type PhaseConfig = z.infer<typeof PHASE_CONFIG_SCHEMA>;
export type RoleConfig = z.infer<typeof ROLE_CONFIG_SCHEMA>;
export type AgentConfig = z.infer<typeof AGENT_CONFIG_SCHEMA>;

// ── Loader ────────────────────────────────────────────────────────

const REPO_RELATIVE_PATH = join(".arkeon", "agents.yaml");

/**
 * Resolve the user-global agents.yaml path at call time so
 * ARKEON_WIKI_HOME (set by `--data-dir` or by the named-instance
 * lifecycle helpers) actually relocates it. A module-level constant
 * captured `homedir()` once at import, which made isolated test
 * environments and named-instance installs silently fall back to the
 * real `~/.arkeon-wiki/agents.yaml`.
 */
function userGlobalPath(): string {
  const base = process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
  return join(base, "agents.yaml");
}

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
  const resolvedUserGlobal = opts.userGlobalPath ?? userGlobalPath();
  const repoLocalPath = opts.spaceDir
    ? join(opts.spaceDir, REPO_RELATIVE_PATH)
    : null;

  const userGlobal = readConfigFile(resolvedUserGlobal);
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
