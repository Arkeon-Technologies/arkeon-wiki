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
 * operator-supplied focus/style instructions. Bundled role templates
 * (templates/*.yaml, loaded by templates.ts) cover the workflow +
 * tool-use patterns; the user's agents.yaml tunes the knobs operators
 * care about.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { validateCronExpression } from "./cron.js";

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
   *  starts. Variables: {{space_id}}, {{space_name}}. (For
   *  cron-driven roles there is no triggering file, so the older
   *  {{trigger_path}} / {{trigger_entity_id}} variables expand to
   *  the empty string.) The first phase's prompt is the initial user
   *  message; subsequent phase prompts are appended. */
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

  /** Cron expression that fires this role on a schedule. Five-field
   *  unix-cron syntax (`min hour day month dow`); validated at config
   *  load time so a typo fails the daemon at startup rather than at
   *  first tick. Omit (or leave undefined in the merged config) to
   *  opt the role out of automatic firing — it can still be invoked
   *  manually by external callers.
   *
   *  Per-space mutex applies: if a role's tick fires while another
   *  role's run is in flight in the same space, the tick is skipped
   *  (skip-if-busy) and the next firing is scheduled from "now."
   *
   *  Examples (in standard 5-field cron syntax):
   *    every 15 minutes, every 6 hours on the hour, daily at 03:00.
   *    Operators write the cron expression directly in agents.yaml.
   */
  cron: z
    .string()
    .min(1)
    .refine((expr) => validateCronExpression(expr) === null, {
      message: "is not a valid cron expression",
    })
    .optional(),

  /** Spaces this role is allowed to read from. Each entry is either a
   *  space name, a space id (ULID), the literal `"self"` (= the space
   *  the run was triggered in), or the literal `"*"` (= every
   *  registered space).
   *
   *  Examples:
   *    spaces: [self]                       # default — own space only
   *    spaces: [self, "data-mining"]        # own space + a sibling
   *    spaces: ["*"]                        # global — see everything
   *
   *  Omitted = `[self]`. Empty array is rejected (write `[self]`
   *  explicitly if you want to be explicit about no other spaces;
   *  `[]` is almost always a config typo). Names are resolved at
   *  run-start; if a name matches multiple registered spaces the
   *  runtime errors out and asks the operator to disambiguate by id.
   *  `"*"` cannot be mixed with named entries — an operator who
   *  wrote `["*", "data-mining"]` thinking they were narrowing scope
   *  would instead get every space, so the runtime errors at
   *  resolution time. Read-only across spaces: writes (`edit_file`,
   *  `delete_wiki`) always target the triggering space regardless
   *  of this setting. */
  spaces: z.array(z.string().min(1)).min(1).optional(),
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
  rejectLegacyTriggers(parsed, path);
  return AGENT_CONFIG_SCHEMA.parse(parsed);
}

/**
 * The pre-cron event-driven scheduler exposed a `triggers:` array on
 * each role. Bundled templates carried defaults; operators sometimes
 * overrode them. The cron rewrite drops both the field and the
 * underlying queue. Catch the legacy field here and tell the operator
 * exactly what to do, instead of letting Zod reject it as
 * "unrecognized key" with no migration path.
 */
function rejectLegacyTriggers(parsed: unknown, path: string): void {
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as Record<string, unknown>;
  const offenders: string[] = [];
  if (root.defaults && typeof root.defaults === "object") {
    if ("triggers" in (root.defaults as object)) offenders.push("defaults");
  }
  if (root.roles && typeof root.roles === "object") {
    for (const [name, role] of Object.entries(root.roles)) {
      if (role && typeof role === "object" && "triggers" in role) {
        offenders.push(`roles.${name}`);
      }
    }
  }
  if (offenders.length === 0) return;
  throw new Error(
    `agents.yaml at ${path} uses the legacy 'triggers:' field on ` +
      `${offenders.join(", ")}. The agent runtime is now cron-paced; ` +
      `replace 'triggers:' with 'cron: \"<expression>\"' (e.g. ` +
      `'cron: \"*/15 * * * *\"' for every 15 minutes). Per-space ` +
      `serialization is now handled by the runtime, so the by_role / ` +
      `by_role_not loop-safety options are no longer needed.`,
  );
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
