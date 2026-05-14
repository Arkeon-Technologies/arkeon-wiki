// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki init [name]` — register the current directory as a space.
 *
 * Creates a space in the running Arkeon instance. The daemon automatically
 * starts watching the directory and syncs all files.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState, type RepoState } from "../../lib/repo-state.js";
import {
  AGENTS_YAML_TEMPLATES,
  DEFAULT_AGENTS_TEMPLATE,
  writeAgentsYamlTemplate,
} from "./config.js";

// --api-url is declared on the root program (src/index.ts); the
// preAction hook moves the value into ARKE_API_URL. Don't redeclare
// it here — duplicate options have a precedence bug in Commander
// where the value lands on globals but the subcommand reads locally.

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .argument("[name]", "Space name (defaults to directory name)")
    .description("Register this directory as an Arkeon space")
    .option(
      "--template <name>",
      `agents.yaml template to lay down (default: ${DEFAULT_AGENTS_TEMPLATE}). ` +
        `Available: ${Object.keys(AGENTS_YAML_TEMPLATES).sort().join(", ")}.`,
      DEFAULT_AGENTS_TEMPLATE,
    )
    .action(async (name: string | undefined, options: { template: string }) => {
      try {
        await runInit(name, options.template);
      } catch (error) {
        output.error(error, { operation: "init" });
        process.exitCode = 1;
      }
    });
}

async function runInit(
  name: string | undefined,
  template: string,
): Promise<void> {
  const cwd = process.cwd();
  const spaceName = name ?? basename(cwd);
  const apiUrl = process.env.ARKE_API_URL ?? `http://localhost:${DEFAULT_API_PORT}`;

  // Check if already initialized
  const existing = loadRepoState();
  if (existing) {
    console.log(`This directory is already initialized (space: ${existing.space_name}).`);
    return;
  }

  // Create space via API — the server will automatically start watching
  const res = await fetch(`${apiUrl}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: spaceName, watch_dir: resolve(cwd) }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(
      `Failed to create space: ${res.status} ${(body as { error?: { message?: string } }).error?.message ?? res.statusText}`,
    );
  }

  const space = (await res.json()) as { name: string; watch_dir: string };

  // Write .arkeon/state.json
  const arkeonDir = join(cwd, ".arkeon");
  if (!existsSync(arkeonDir)) mkdirSync(arkeonDir, { recursive: true });

  const state: RepoState = {
    api_url: apiUrl,
    space_name: space.name,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(arkeonDir, "state.json"), JSON.stringify(state, null, 2));

  // Gitignore the per-clone state file AND `.env` (where API keys
  // land). `.arkeon/agents.yaml` and any other configuration in the
  // .arkeon dir are intended to be committed so the team shares them.
  // If `.gitignore` doesn't exist yet we create it — leaking a
  // provider key is a worse outcome than silently materializing a
  // one-line file.
  const gitignoreChanged = ensureGitignoreEntries(cwd, [
    ".arkeon/state.json",
    ".env",
  ]);

  // Create wiki/ directory
  const wikiDir = join(cwd, "wiki");
  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });

  // Lay down .arkeon/agents.yaml from a named template. Idempotent:
  // if the file already exists we leave it alone so re-running `init`
  // (or `init` after a manual edit) never clobbers operator config.
  const agentsYaml = writeAgentsYamlTemplate({ targetDir: cwd, template });

  output.result({
    operation: "init",
    space_name: space.name,
    watch_dir: resolve(cwd),
    agents_yaml: {
      path: agentsYaml.path,
      created: agentsYaml.created,
      template: agentsYaml.template,
    },
    gitignore_updated: gitignoreChanged,
    hint:
      agentsYaml.created
        ? "The daemon is now watching this directory. Edit .arkeon/agents.yaml " +
          "to set your provider/model and operator instructions, then drop your " +
          "API key in ~/.arkeon-wiki/.env or ./.env."
        : "The daemon is now watching this directory. Any files you add will be " +
          "synced automatically.",
  });
}

/**
 * Ensure each entry exists in `<cwd>/.gitignore`, creating the file
 * if it doesn't exist. Returns true if any write happened. Also
 * migrates the legacy `.arkeon/` line (which would hide committed
 * config) to the narrower `.arkeon/state.json` when the latter is
 * one of the requested entries.
 */
function ensureGitignoreEntries(cwd: string, entries: string[]): boolean {
  const gitignorePath = join(cwd, ".gitignore");
  const existed = existsSync(gitignorePath);
  const original = existed ? readFileSync(gitignorePath, "utf-8") : "";
  let updated = original;

  // Legacy `.arkeon/` → `.arkeon/state.json` migration. Only relevant
  // when `.arkeon/state.json` is being ensured.
  const stateEntry = ".arkeon/state.json";
  if (entries.includes(stateEntry)) {
    const stale = ".arkeon/";
    const hasStale = updated.split("\n").some((line) => line.trim() === stale);
    if (hasStale && !updated.includes(stateEntry)) {
      updated = updated
        .split("\n")
        .map((line) => (line.trim() === stale ? stateEntry : line))
        .join("\n");
    }
  }

  // Per-line presence check — `.env` would match `.envrc` if we used
  // `includes`, so compare trimmed lines exactly.
  const presentLines = new Set(updated.split("\n").map((l) => l.trim()));
  const toAdd = entries.filter((e) => !presentLines.has(e));
  if (toAdd.length > 0) {
    updated = `${updated.trimEnd()}\n${toAdd.join("\n")}\n`;
    // If the file was empty/missing, drop the leading newline.
    if (!existed) updated = updated.replace(/^\n/, "");
  }

  if (updated === original) return false;
  writeFileSync(gitignorePath, updated);
  return true;
}
