// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon init [space-name]` — bind a repository to an Arkeon space.
 *
 * Creates an agent actor, a space, and writes .arkeon/state.json.
 * API key is stored in the global credential store, not in state.json.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";

import { apiPost } from "../../lib/api-client.js";
import { credentials } from "../../lib/credentials.js";
import { findInstanceByName, listInstances, resolveAdminKeyForUrl, saveInstanceActor } from "../../lib/instances.js";
import { installAgentsMd } from "../install/providers.js";
import { isProcessAlive, readSecrets } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { saveRepoState, stateFilePath } from "../../lib/repo-state.js";

interface InitOptions {
  apiUrl?: string;
  instance?: string;
  force?: boolean;
}

type ActorResponse = {
  actor: { id: string };
  api_key: string;
};

type SpaceResponse = {
  space: { id: string; name: string };
};

function resolveAdminKey(apiUrl: string): string {
  // 1. Env var
  const envKey = process.env.ARKE_ADMIN_KEY?.trim();
  if (envKey) return envKey;

  // 2. Instance registry — find the stack serving this URL and read its secrets
  const registryKey = resolveAdminKeyForUrl(apiUrl);
  if (registryKey) return registryKey;

  // 3. Default ARKEON_WIKI_HOME secrets.json (fallback for single-stack setups)
  const secrets = readSecrets();
  if (secrets?.adminBootstrapKey) return secrets.adminBootstrapKey;

  throw new Error(
    "No admin key found for " + apiUrl + ". Set ARKE_ADMIN_KEY or start the local stack first (`arkeon up`).",
  );
}

function resolveApiUrl(opts: { apiUrl?: string; instance?: string }): string {
  if (opts.apiUrl) return opts.apiUrl.replace(/\/$/, "");
  if (process.env.ARKE_API_URL) return process.env.ARKE_API_URL.replace(/\/$/, "");

  // --instance flag: look up by name
  if (opts.instance) {
    const inst = findInstanceByName(opts.instance);
    if (!inst) {
      const running = listInstances().filter((i) => isProcessAlive(i.pid));
      const names = running.map((i) => i.name).join(", ");
      throw new Error(
        `No instance named "${opts.instance}". Running instances: ${names || "(none)"}`,
      );
    }
    return inst.api_url;
  }

  // Auto-detect: if exactly one instance is running, use it
  const running = listInstances().filter((i) => isProcessAlive(i.pid));
  if (running.length === 1) {
    return running[0]!.api_url;
  }
  if (running.length > 1) {
    const list = running.map((i) => `  ${i.name} — ${i.api_url}`).join("\n");
    throw new Error(
      `Multiple Arkeon instances are running:\n${list}\n\n` +
      `Specify which one with: arkeon init --instance <name>`,
    );
  }

  return "http://localhost:8000";
}

const FOCUS_TEMPLATE = `# Worker focus prompts — guide what the wiki extracts and how it writes.
# Edit these prompts, then run \`arkeon-wiki focus\` to apply.
# Keys correspond to worker names. Current workers: extract, draft, enrich.

# What subjects to extract from documents
extract: ""

# How to write new wiki articles
draft: ""

# How to update existing wikis when new sources arrive (falls back to draft if empty)
enrich: ""
`;

function writeFocusTemplate(cwd: string): void {
  const focusPath = join(cwd, ".arkeon", "focus.yaml");
  if (existsSync(focusPath)) return;
  const dir = join(cwd, ".arkeon");
  mkdirSync(dir, { recursive: true });
  writeFileSync(focusPath, FOCUS_TEMPLATE);
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  const entries = [".arkeon/state.json", ".arkeon/manifest.json"];
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    const missing = entries.filter((e) => !content.includes(e));
    if (missing.length === 0) return;
    appendFileSync(gitignorePath, `\n${missing.join("\n")}\n`);
  } else {
    appendFileSync(gitignorePath, `${entries.join("\n")}\n`);
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Bind this repo to an Arkeon space — creates a space, an agent actor, and writes .arkeon/state.json")
    .argument("[space-name]", "Name for the space (defaults to directory name)")
    .option("--api-url <url>", "Override API base URL")
    .option("--instance <name>", "Connect to a named instance (from `arkeon up --name`)")
    .option("--force", "Re-initialize even if .arkeon/state.json exists")
    .action(async (spaceName: string | undefined, opts: InitOptions) => {
      try {
        const cwd = process.cwd();

        // Check if already initialized
        if (!opts.force && existsSync(stateFilePath(cwd))) {
          output.error(
            new Error(".arkeon/state.json already exists. Use --force to re-initialize."),
            { operation: "init" },
          );
          process.exitCode = 1;
          return;
        }

        const apiUrl = resolveApiUrl(opts);
        const adminKey = resolveAdminKey(apiUrl);
        const name = spaceName ?? basename(cwd);

        // Verify stack is reachable
        output.progress(`Connecting to ${apiUrl}...`);
        try {
          const healthResp = await fetch(`${apiUrl}/health`);
          if (!healthResp.ok) throw new Error(`Health check returned ${healthResp.status}`);
        } catch (err) {
          throw new Error(
            `Cannot reach ${apiUrl}. Is the stack running? Try \`arkeon up\` first.\n(${(err as Error).message})`,
          );
        }

        // Create agent actor
        output.progress("Creating agent actor...");
        const actorResp = await apiPost<ActorResponse>(apiUrl, "/actors", adminKey, {
          kind: "agent",
          properties: { label: `ingestor-${name}` },
        });
        const actorId = actorResp.actor.id;
        const actorApiKey = actorResp.api_key;

        // Store key in global credential store + instance actor registry
        credentials.saveActorKey(actorId, actorApiKey, `ingestor-${name}`);
        saveInstanceActor(apiUrl, "ingestor", actorId);

        // Create space (using the new actor's key — actor becomes owner)
        output.progress(`Creating space "${name}"...`);
        const spaceResp = await apiPost<SpaceResponse>(apiUrl, "/spaces", actorApiKey, {
          name,
          description: `Repository: ${name}`,
          properties: { repo_root: cwd },
        });

        // Write state file
        saveRepoState(
          {
            api_url: apiUrl,
            space_id: spaceResp.space.id,
            space_name: spaceResp.space.name,
            current_actor: "ingestor",
            actors: {
              ingestor: { actor_id: actorId },
            },
            created_at: new Date().toISOString(),
          },
          cwd,
        );

        // Write focus.yaml template for worker prompt customization
        writeFocusTemplate(cwd);

        // Gitignore the state file (contains no secrets but keep it out of version control by default)
        ensureGitignore(cwd);

        // Write AGENTS.md for universal AI coding tool support
        installAgentsMd();

        output.result({
          operation: "init",
          space_id: spaceResp.space.id,
          space_name: spaceResp.space.name,
          actor_id: actorId,
          api_url: apiUrl,
          state_file: stateFilePath(cwd),
          next: "arkeon diff / arkeon add <files>",
        });
      } catch (error) {
        output.error(error, { operation: "init" });
        process.exitCode = 1;
      }
    });
}
