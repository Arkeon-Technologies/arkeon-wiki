// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki config <subcommand>` — manage the agent configuration.
 *
 * Subcommands:
 *   show        print the merged effective config (built-ins + YAML)
 *   init        create .arkeon/agents.yaml from a template
 *   validate    schema-check .arkeon/agents.yaml
 *
 * The config file is `.arkeon/agents.yaml` in the current repo (or
 * `~/.arkeon-wiki/agents.yaml` for user-global defaults). Both are
 * optional; the runtime falls back to the built-in templates plus
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
import { BUILTIN_ROLES } from "../../../server/agents/builtins.js";
import { listAvailableRoles } from "../../../server/agents/role-builder.js";
import { output } from "../../lib/output.js";

const REPO_RELATIVE_PATH = join(".arkeon", "agents.yaml");

const TEMPLATE = `# .arkeon/agents.yaml
#
# Per-repo agent configuration. Committed to the repo so the team
# shares the same focus, model choices, and operator instructions.
# Secrets never live here — set OPENAI_API_KEY / ANTHROPIC_API_KEY
# in .env (gitignored) or your shell.
#
# Built-in roles (contributor, editor) are defined in the package and
# inherited automatically. Override their fields here, or define your
# own custom roles. Run \`arkeon-wiki config show\` to see the merged
# effective config.

defaults:
  provider: openai             # openai | anthropic | openai-compatible
  model: gpt-5-mini
  # Operator-supplied focus / style notes. Appended to every role's
  # system prompt. Use this to steer subjects, tone, scope.
  # instructions: |
  #   This wiki tracks researchers in climate science. Skip subjects
  #   not directly relevant. Cross-link to existing wikis.

# Per-role overrides (built-in roles inherit by name). Add custom
# roles here too — they need at least 'system' and 'tools'.
#
# roles:
#   contributor:
#     model: gpt-5-mini
#     max_steps: 12
#     instructions: |
#       Be aggressive about creating placeholders for named subjects.
#
#   editor:
#     provider: anthropic
#     model: claude-opus-4-7
#     api_key_env: ANTHROPIC_API_KEY    # optional, default per provider
#     max_steps: 20
#
#   link-checker:                       # custom user-defined role
#     model: gpt-5-mini
#     tools: [list_wikis, read_file, edit_file]
#     max_steps: 30
#     system: |
#       You find broken cross-references and fix them.
#     user: |
#       Wiki: {{trigger_entity_id}}
`;

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
    .action(async (options: { force: boolean }) => {
      try {
        await runInit(options.force);
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

  console.log(`# Available roles (${roles.length}):`);
  for (const name of roles) {
    const isBuiltin = Object.prototype.hasOwnProperty.call(BUILTIN_ROLES, name);
    const overridden = !!merged.roles?.[name];
    const tag =
      isBuiltin && overridden
        ? "(builtin, overridden)"
        : isBuiltin
        ? "(builtin)"
        : "(custom)";
    console.log(`#   ${name}  ${tag}`);
  }
}

async function runInit(force: boolean): Promise<void> {
  const cwd = process.cwd();
  const target = resolve(cwd, REPO_RELATIVE_PATH);

  if (existsSync(target) && !force) {
    output.result({
      operation: "config init",
      created: false,
      path: target,
      hint: "File already exists. Use --force to overwrite, or edit it directly.",
    });
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, TEMPLATE);

  output.result({
    operation: "config init",
    created: true,
    path: target,
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
