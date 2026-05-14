// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki init [name]` — register the current directory as a space.
 *
 * First run: creates a space in the running Arkeon instance (POST
 * /spaces), writes `.arkeon/state.json`, gitignores `.env` + state,
 * creates `wiki/`, and lays down `.arkeon/agents.yaml` from a named
 * template.
 *
 * Re-run (state.json already present): reconcile mode. Skips the API
 * call, leaves state.json alone, but still ensures `.gitignore`,
 * `wiki/`, and `.arkeon/agents.yaml` exist. All three helpers are
 * idempotent (no clobber on existing files), so a user who deleted
 * `.arkeon/agents.yaml` by hand or init'd with a pre-template version
 * of the CLI can recover by re-running `init` — no need for a
 * separate `config init` step.
 *
 * The `name` argument is ignored in reconcile mode; the existing
 * space_name from state.json is canonical.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  DEFAULT_INSTANCE_NAME,
  listInstances,
  type Instance,
} from "../../lib/instances.js";
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
  const apiUrl = resolveApiUrl();

  // Branch on whether the space is already known locally. Reconcile
  // mode skips the API call and the state.json write but still runs
  // the three idempotent fill-in-missing-pieces helpers below.
  const existing = loadRepoState();
  let space: { name: string; watch_dir: string };
  const reconciled = existing !== null;

  if (existing) {
    space = { name: existing.space_name, watch_dir: resolve(cwd) };
  } else {
    const spaceName = name ?? basename(cwd);

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

    space = (await res.json()) as { name: string; watch_dir: string };

    // Write .arkeon/state.json
    const arkeonDir = join(cwd, ".arkeon");
    if (!existsSync(arkeonDir)) mkdirSync(arkeonDir, { recursive: true });

    const state: RepoState = {
      api_url: apiUrl,
      space_name: space.name,
      created_at: new Date().toISOString(),
    };
    writeFileSync(join(arkeonDir, "state.json"), JSON.stringify(state, null, 2));
  }

  // ── Reconcile pass (runs in both first-init and re-run) ────────
  //
  // All three helpers are idempotent: ensureGitignoreEntries skips
  // already-present lines, mkdirSync `recursive` is a no-op on an
  // existing dir, and writeAgentsYamlTemplate refuses to overwrite
  // an existing file unless `force` is set. So a re-run repairs
  // anything missing without clobbering hand-edits.

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

  // Lay down .arkeon/agents.yaml from a named template.
  const agentsYaml = writeAgentsYamlTemplate({ targetDir: cwd, template });

  output.result({
    operation: "init",
    space_name: space.name,
    watch_dir: resolve(cwd),
    reconciled,
    agents_yaml: {
      path: agentsYaml.path,
      created: agentsYaml.created,
      template: agentsYaml.template,
    },
    gitignore_updated: gitignoreChanged,
    hint: buildHint({ reconciled, agentsYamlCreated: agentsYaml.created, gitignoreChanged }),
  });
}

function buildHint(args: {
  reconciled: boolean;
  agentsYamlCreated: boolean;
  gitignoreChanged: boolean;
}): string {
  if (!args.reconciled) {
    // First init — point the user at config next.
    return (
      "The daemon is now watching this directory. Edit .arkeon/agents.yaml " +
      "to set your provider/model and operator instructions, then drop your " +
      "API key in ~/.arkeon-wiki/.env or ./.env."
    );
  }
  // Re-run — be explicit about what (if anything) was filled in.
  const filled: string[] = [];
  if (args.agentsYamlCreated) filled.push(".arkeon/agents.yaml");
  if (args.gitignoreChanged) filled.push(".gitignore");
  if (filled.length === 0) {
    return "Already initialized — nothing to reconcile.";
  }
  return `Already initialized — restored missing: ${filled.join(", ")}.`;
}

/**
 * Decide which daemon `init` should talk to. Every other CLI command
 * gets the api_url from `.arkeon/state.json`, but `init` runs before
 * state.json exists — it has to discover the daemon some other way.
 *
 * Priority chain (most specific wins):
 *
 *   1. `ARKE_API_URL` env var or `--api-url` flag (moved into the env
 *      var by the root preAction hook). Explicit override.
 *   2. The "default" instance — i.e. a daemon started by plain
 *      `arkeon-wiki up` (no `--name`). This is the 99% case and the
 *      port is :8000.
 *   3. Exactly one named instance running. If the user has a single
 *      `--name foo` daemon and no default, init talks to it.
 *   4. Nothing running, or multiple named with no default → throw a
 *      message that names the running instances and tells the user
 *      to pass `--api-url`.
 *
 * Both lookups go through `listInstances()`, which prunes stale
 * registry entries (dead PIDs) before returning. A crashed daemon's
 * leftover `default.json` therefore can't fool us into returning a
 * dead api_url and producing the exact `fetch failed` UX this helper
 * exists to eliminate.
 *
 * The `deps` argument exists for unit tests — production callers omit
 * it and the registry lookup goes through the real filesystem.
 */
export interface ResolveApiUrlDeps {
  env?: NodeJS.ProcessEnv;
  listInstances?: () => Instance[];
}

export function resolveApiUrl(deps: ResolveApiUrlDeps = {}): string {
  const env = deps.env ?? process.env;
  const listInst = deps.listInstances ?? listInstances;

  // (1) Explicit override.
  const fromEnv = env.ARKE_API_URL;
  if (fromEnv) return fromEnv;

  // (2)+(3) live-pid-filtered registry.
  const running = listInst();
  const defaultInst = running.find((i) => i.name === DEFAULT_INSTANCE_NAME);
  if (defaultInst) return defaultInst.api_url;
  if (running.length === 1) return running[0].api_url;

  // (4) Error path — describe what we found so the user can choose.
  if (running.length === 0) {
    throw new Error(
      "No arkeon-wiki daemon is running. Start one with `arkeon-wiki up` " +
        "(or pass `--api-url <url>` to point at a daemon elsewhere).",
    );
  }
  const list = running
    .map((i: Instance) => `  - ${i.name} (${i.api_url})`)
    .join("\n");
  throw new Error(
    `Multiple arkeon-wiki daemons are running and none of them is the default. ` +
      `Pick one with --api-url <url>:\n${list}`,
  );
}

/**
 * Ensure each entry exists in `<cwd>/.gitignore`, creating the file
 * if it doesn't exist. Returns true if any write happened. Also
 * migrates the legacy `.arkeon/` line (which would hide committed
 * config) to the narrower `.arkeon/state.json` when the latter is
 * one of the requested entries.
 *
 * Exported for direct unit testing — the legacy-migration and
 * empty/missing-file branches are non-trivial enough that exercising
 * them only through `runInit` (which requires a live daemon) is too
 * thin a coverage net.
 */
export function ensureGitignoreEntries(cwd: string, entries: string[]): boolean {
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
