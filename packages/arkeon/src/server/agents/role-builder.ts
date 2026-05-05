// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns declarative role config (YAML + built-in templates) into the
 * runtime AgentRole object that runAgent consumes.
 *
 * Resolution chain for each field, most specific wins:
 *   1. config.roles[name]
 *   2. BUILTIN_ROLES[name]   (only when it's a built-in)
 *   3. config.defaults
 *
 * Required-everywhere fields (provider, model, system, tools) must
 * resolve to *something* by the end; otherwise we throw clearly.
 *
 * `instructions` is the only field that *layers* (defaults +
 * role-specific are concatenated to the system prompt). All other
 * fields use last-write-wins.
 */

import type { ModelConfig } from "./model.js";
import type { AgentConfig, PhaseConfig, RoleConfig } from "./config.js";
import { BUILTIN_ROLES, isBuiltinRole } from "./builtins.js";
import {
  hashInput,
  type AgentInput,
  type AgentPhase,
  type AgentRole,
  type IdempotencyKey,
} from "./runtime.js";

/**
 * Build an AgentRole for the named role from the declarative config.
 *
 * Throws if a required field can't be resolved (e.g. a custom role
 * with no built-in template and no `system` in YAML).
 */
export function buildAgentRole(name: string, config: AgentConfig): AgentRole {
  const builtin: RoleConfig = isBuiltinRole(name) ? BUILTIN_ROLES[name] : {};
  const fromConfig: RoleConfig = config.roles?.[name] ?? {};
  const defaults: RoleConfig = config.defaults ?? {};

  // Field-level resolution (most specific wins).
  const provider =
    fromConfig.provider ?? builtin.provider ?? defaults.provider;
  const modelId = fromConfig.model ?? builtin.model ?? defaults.model;
  const baseUrl =
    fromConfig.base_url ?? builtin.base_url ?? defaults.base_url;
  const apiKeyEnv =
    fromConfig.api_key_env ?? builtin.api_key_env ?? defaults.api_key_env;

  if (!provider) {
    throw new Error(
      `Role '${name}': no provider resolved (set provider in defaults or roles.${name}).`,
    );
  }
  if (!modelId) {
    throw new Error(
      `Role '${name}': no model id resolved (set model in defaults or roles.${name}).`,
    );
  }

  const tools = fromConfig.tools ?? builtin.tools ?? defaults.tools ?? [];
  if (tools.length === 0) {
    throw new Error(
      `Role '${name}': no tools configured (set tools in roles.${name} or builtin).`,
    );
  }

  const maxSteps =
    fromConfig.max_steps ?? builtin.max_steps ?? defaults.max_steps ?? 10;

  // Prompt resolution: system replaces, instructions layer.
  const baseSystem = fromConfig.system ?? builtin.system;
  if (!baseSystem) {
    throw new Error(
      `Role '${name}': no system prompt. Custom (non-builtin) roles must ` +
        `set 'system' in YAML.`,
    );
  }
  const instructionsLayer = [defaults.instructions, fromConfig.instructions]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n\n");
  const system = instructionsLayer
    ? `${baseSystem}\n\n--- Operator instructions ---\n${instructionsLayer}`
    : baseSystem;

  const apiKey = resolveApiKey(provider, apiKeyEnv);
  const model = toModelConfig(provider, modelId, baseUrl, apiKey);

  // Resolve phases. `phases` (if present anywhere in the chain) wins
  // over the legacy single-phase `user` field. The `phases` config
  // never merges field-by-field: whichever level supplies it wins
  // wholesale (most-specific-wins), so a user can override the entire
  // pipeline by setting their own phases array.
  const phasesConfig =
    fromConfig.phases ?? builtin.phases ?? defaults.phases ?? null;

  let phases: PhaseConfig[];
  if (phasesConfig) {
    phases = phasesConfig;
  } else {
    // Legacy / single-phase synthesis from `user`.
    const userTemplate =
      fromConfig.user ?? builtin.user ?? defaults.user ?? "{{user_input}}";
    phases = [{ prompt: userTemplate }];
  }

  // Per-phase model shorthand. Keyed by phase.name so users don't have
  // to know phase ordering. Layered like defaults — defaults < builtin
  // < role — and folded into the per-phase resolution below.
  const phaseModelOverrides: Record<string, string> = {
    ...defaults.phase_models,
    ...builtin.phase_models,
    ...fromConfig.phase_models,
  };

  // Resolve each phase's overrides against the role-level fallbacks.
  const resolvedPhases = phases.map((p, i): ResolvedPhase => {
    const phaseTools = p.tools ?? tools;
    if (phaseTools.length === 0) {
      throw new Error(
        `Role '${name}' phase ${i}: no tools (set phase.tools or role.tools).`,
      );
    }
    const phaseName = p.name ?? `phase-${i + 1}`;
    // Precedence: explicit phase.model wins over phase_models lookup,
    // which wins over the role-level model.
    const phaseModelId =
      p.model ?? phaseModelOverrides[phaseName] ?? modelId;
    return {
      name: phaseName,
      promptTemplate: p.prompt,
      tools: phaseTools,
      maxSteps: p.max_steps ?? maxSteps,
      // Per-phase model overrides keep the role's provider, base_url,
      // and api_key — same provider only.
      model: toModelConfig(provider, phaseModelId, baseUrl, apiKey),
    };
  });

  return {
    name,
    model,
    tools,
    maxSteps,
    buildPhases: async (input: AgentInput) => ({
      system: fillTemplate(system, promptVars(name, input)),
      phases: resolvedPhases.map(
        (p): AgentPhase => ({
          name: p.name,
          prompt: fillTemplate(p.promptTemplate, promptVars(name, input)),
          model: p.model,
          tools: p.tools,
          maxSteps: p.maxSteps,
        }),
      ),
    }),
    idempotencyKey: defaultIdempotencyKey(name),
    concurrencyKey: defaultConcurrencyKey(name),
  };
}

interface ResolvedPhase {
  name: string;
  promptTemplate: string;
  tools: string[];
  maxSteps: number;
  model: ModelConfig;
}

// ── Prompt template ──────────────────────────────────────────────

export function promptVars(
  roleName: string,
  input: AgentInput,
): Record<string, string> {
  return {
    role_name: roleName,
    trigger_path: input.triggerPath ?? "",
    trigger_entity_id: input.triggerEntityId ?? "",
    space_id: input.space.id,
    space_name: input.space.name,
    space_watch_dir: input.space.watch_dir,
  };
}

export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : "",
  );
}

// ── Defaults for keying functions ────────────────────────────────

export function defaultIdempotencyKey(
  roleName: string,
): (input: AgentInput) => IdempotencyKey {
  return (input: AgentInput): IdempotencyKey => {
    const key =
      input.triggerPath ??
      input.triggerEntityId ??
      `${roleName}::${input.space.id}`;
    const hash = hashInput({
      triggerPath: input.triggerPath ?? null,
      triggerEntityId: input.triggerEntityId ?? null,
      meta: input.meta ?? null,
    });
    return { key, hash };
  };
}

export function defaultConcurrencyKey(
  roleName: string,
): (input: AgentInput) => string {
  return (input: AgentInput) =>
    input.triggerEntityId
      ? `${roleName}::${input.space.id}::${input.triggerEntityId}`
      : `${roleName}::${input.space.id}`;
}

// ── Provider/key plumbing ────────────────────────────────────────

const DEFAULT_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

function resolveApiKey(
  provider: string,
  apiKeyEnv: string | undefined,
): string | undefined {
  const envName = apiKeyEnv ?? DEFAULT_API_KEY_ENV[provider];
  if (!envName) return undefined;
  const value = process.env[envName];
  if (!value && provider !== "openai-compatible") {
    throw new Error(
      `Provider '${provider}' requires env var ${envName} (not set).`,
    );
  }
  return value;
}

function toModelConfig(
  provider: string,
  id: string,
  baseUrl: string | undefined,
  apiKey: string | undefined,
): ModelConfig {
  switch (provider) {
    case "anthropic":
      return { provider: "anthropic", id, apiKey };
    case "openai":
      return { provider: "openai", id, apiKey };
    case "openai-compatible":
      if (!baseUrl) {
        throw new Error(
          "Provider 'openai-compatible' requires base_url to be set.",
        );
      }
      return {
        provider: "openai-compatible",
        id,
        baseURL: baseUrl,
        apiKey,
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Discovery ────────────────────────────────────────────────────

/**
 * List all role names available given a config: built-ins plus any
 * roles defined in YAML. Useful for `arkeon-wiki agent list`.
 */
export function listAvailableRoles(config: AgentConfig): string[] {
  const set = new Set<string>(Object.keys(BUILTIN_ROLES));
  for (const name of Object.keys(config.roles ?? {})) set.add(name);
  return [...set].sort();
}
