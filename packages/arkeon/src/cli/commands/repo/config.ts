// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki config <subcommand>` — manage the agent configuration.
 *
 * Subcommands:
 *   show        print the merged effective config (templates + YAML)
 *   init        create .arkeon/agents.yaml from a template
 *   validate    schema-check .arkeon/agents.yaml
 *
 * The config file is `.arkeon/agents.yaml` in the current repo (or
 * `~/.arkeon-wiki/agents.yaml` for user-global defaults). Both are
 * optional; the runtime falls back to the bundled role templates plus
 * env-var-based key resolution.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import yaml from "js-yaml";

import {
  AGENT_CONFIG_SCHEMA,
  loadAgentConfig,
} from "../../../server/agents/config.js";
import { loadBundledTemplates } from "../../../server/agents/templates.js";
import { listAvailableRoles } from "../../../server/agents/role-builder.js";
import { output } from "../../lib/output.js";

export const AGENTS_YAML_RELATIVE_PATH = join(".arkeon", "agents.yaml");

// Kept as a const for back-compat with anything still importing it.
const REPO_RELATIVE_PATH = AGENTS_YAML_RELATIVE_PATH;

export const DEFAULT_AGENTS_TEMPLATE = "wiki";

const WIKI_TEMPLATE = `# .arkeon/agents.yaml
#
# Per-repo agent configuration. Committed to the repo so the team
# shares the same focus, model choices, and operator instructions.
# Secrets never live here — set OPENAI_API_KEY / ANTHROPIC_API_KEY
# in .env (gitignored) or your shell.
#
# The bundled 'writer' role ships with the package and is inherited
# automatically. Override its fields here, or define your own custom
# roles. Run \`arkeon-wiki config show\` to see the merged effective
# config.

defaults:
  provider: openai             # openai | anthropic | openai-compatible
  model: gpt-5-mini
  # 'instructions' is THE knob that makes your wiki opinionated.
  # It's appended to every role's system prompt — editor, proposer,
  # writer — without disturbing their workflows. Use it to declare
  # what the wiki is about, what it's NOT about, what tone to take,
  # and who the audience is. Without this, agents will write a
  # generic wiki on whatever they find. With it, the corpus develops
  # a point of view.
  # instructions: |
  #   This wiki is about <topic>. Skip <out-of-scope subjects>.
  #   Bias toward <preferred source types>. Tone: <voice>.
  #   Audience: <reader profile>.

# Per-role overrides (the bundled roles inherit by name). Add
# custom roles here too — they need at least 'system', 'tools',
# and 'cron' (any role without 'cron' is template-only and won't
# auto-run).
#
# roles:
#   writer:
#     model: gpt-5-mini
#     max_steps: 20
#     cron: "*/30 * * * *"            # override default firing cadence
#     instructions: |
#       Use British English. Each new article should be 600-1000
#       words. Skip generic terms.
#
#   curator:                          # custom user-defined role
#     model: gpt-5-mini
#     tools: [list_entities, read_file, edit_file]
#     max_steps: 30
#     cron: "0 4 * * *"               # daily at 04:00
#     system: |
#       You find articles whose theses no longer match their evidence
#       and rewrite the thesis.
`;

/**
 * Registry of named templates that `arkeon-wiki init` and
 * `arkeon-wiki config init` can lay down. Today there's one (`wiki`);
 * the indirection exists so additional templates (e.g. a
 * source-archive-only template, a notebook template) can land as new
 * entries without changing the CLI surface.
 */
export const AGENTS_YAML_TEMPLATES: Record<string, string> = {
  wiki: WIKI_TEMPLATE,
};

export interface WriteAgentsYamlOptions {
  /** The repo root. The file is written at {targetDir}/.arkeon/agents.yaml. */
  targetDir: string;
  /** Named template from AGENTS_YAML_TEMPLATES. Defaults to "wiki". */
  template?: string;
  /** Overwrite an existing file. Defaults to false. */
  force?: boolean;
}

export interface WriteAgentsYamlResult {
  /** False if the file already existed and force was not set. */
  created: boolean;
  /** Absolute path to the target file. */
  path: string;
  /** Resolved template name. */
  template: string;
}

/**
 * Write `.arkeon/agents.yaml` from a named template. Idempotent unless
 * `force` is set: an existing file is left untouched.
 *
 * Throws if the template name isn't registered — the error lists what
 * names are available so the caller can correct a typo.
 */
export function writeAgentsYamlTemplate(
  opts: WriteAgentsYamlOptions,
): WriteAgentsYamlResult {
  const templateName = opts.template ?? DEFAULT_AGENTS_TEMPLATE;
  const content = AGENTS_YAML_TEMPLATES[templateName];
  if (!content) {
    const available = Object.keys(AGENTS_YAML_TEMPLATES).sort().join(", ");
    throw new Error(
      `Unknown agents.yaml template '${templateName}'. Available: ${available}.`,
    );
  }
  const target = resolve(opts.targetDir, AGENTS_YAML_RELATIVE_PATH);
  if (existsSync(target) && !opts.force) {
    return { created: false, path: target, template: templateName };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return { created: true, path: target, template: templateName };
}

export function registerConfigCommand(program: Command): void {
  const cmd = program
    .command("config")
    .description("Manage the agent configuration");

  cmd
    .command("show")
    .description("Print the merged effective config (env + repo + global)")
    .action(async () => {
      try {
        await runShow();
      } catch (error) {
        output.error(error, { operation: "config show" });
        process.exitCode = 1;
      }
    });

  cmd
    .command("init")
    .description("Create .arkeon/agents.yaml from a template")
    .option("--force", "Overwrite an existing file", false)
    .option(
      "--template <name>",
      `Named template to use (default: ${DEFAULT_AGENTS_TEMPLATE}). ` +
        `Available: ${Object.keys(AGENTS_YAML_TEMPLATES).sort().join(", ")}.`,
      DEFAULT_AGENTS_TEMPLATE,
    )
    .action(async (options: { force: boolean; template: string }) => {
      try {
        await runInit(options.force, options.template);
      } catch (error) {
        output.error(error, { operation: "config init" });
        process.exitCode = 1;
      }
    });

  cmd
    .command("validate")
    .description("Schema-check .arkeon/agents.yaml")
    .action(async () => {
      try {
        await runValidate();
      } catch (error) {
        output.error(error, { operation: "config validate" });
        process.exitCode = 1;
      }
    });
}

async function runShow(): Promise<void> {
  const cwd = process.cwd();
  const merged = loadAgentConfig({ spaceDir: cwd });
  const roles = listAvailableRoles(merged);

  console.log("# Effective agent configuration");
  console.log(`# spaceDir: ${cwd}`);
  console.log("");
  console.log(yaml.dump({ defaults: merged.defaults ?? {}, roles: merged.roles ?? {} }, { sortKeys: false }));

  const templates = loadBundledTemplates();
  console.log(`# Available roles (${roles.length}):`);
  for (const name of roles) {
    const isTemplate = Object.prototype.hasOwnProperty.call(templates, name);
    const overridden = !!merged.roles?.[name];
    const tag =
      isTemplate && overridden
        ? "(template, overridden)"
        : isTemplate
        ? "(template)"
        : "(custom)";
    console.log(`#   ${name}  ${tag}`);
  }
}

async function runInit(force: boolean, template: string): Promise<void> {
  const cwd = process.cwd();
  const result = writeAgentsYamlTemplate({ targetDir: cwd, template, force });

  if (!result.created) {
    output.result({
      operation: "config init",
      created: false,
      path: result.path,
      template: result.template,
      hint: "File already exists. Use --force to overwrite, or edit it directly.",
    });
    return;
  }

  output.result({
    operation: "config init",
    created: true,
    path: result.path,
    template: result.template,
    hint:
      "Edit this file to set your provider/model and operator instructions. " +
      "Add API keys to .env (not this file).",
  });
}

async function runValidate(): Promise<void> {
  const cwd = process.cwd();
  const target = resolve(cwd, REPO_RELATIVE_PATH);

  if (!existsSync(target)) {
    output.result({
      operation: "config validate",
      valid: true,
      path: target,
      hint: "No agents.yaml present — runtime will use built-in defaults.",
    });
    return;
  }

  const text = readFileSync(target, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agents.yaml is not valid YAML: ${msg}`);
  }
  // Throws ZodError on schema violations; output.error formats it.
  AGENT_CONFIG_SCHEMA.parse(parsed ?? {});

  output.result({
    operation: "config validate",
    valid: true,
    path: target,
  });
}
