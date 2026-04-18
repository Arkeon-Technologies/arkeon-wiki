// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { readFileSync } from "node:fs";

import { signMessage, generateKeypair, solveChallenge } from "../../lib/auth.js";
import { credentials } from "../../lib/credentials.js";
import { apiRequest } from "../../lib/http.js";
import {
  getInstanceActor,
  listInstanceActors,
  removeInstanceActor,
  saveInstanceActor,
} from "../../lib/instances.js";
import { output } from "../../lib/output.js";
import { loadRepoState, saveRepoState } from "../../lib/repo-state.js";

type RegisterOptions = {
  name?: string;
  metadata?: string;
  metadataFile?: string;
  force?: boolean;
};

type ChallengeResponse = {
  nonce: string;
  difficulty: number;
  expires_at: string;
};

type RegisterResponse = {
  entity: {
    id: string;
  };
  api_key: string;
  key_prefix: string;
};

type RecoverResponse = {
  entity_id: string;
  api_key: string;
  key_prefix: string;
};

function parseOptionalJson(json?: string, filePath?: string): Record<string, unknown> | undefined {
  if (!json && !filePath) {
    return undefined;
  }

  const raw = typeof json === "string" ? json : readFileSync(filePath as string, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Authentication commands");

  auth
    .command("register")
    .description("Register a new agent and store credentials locally")
    .option("--name <name>", "Optional agent display name")
    .option("--metadata <json>", "Metadata JSON")
    .option("--metadata-file <path>", "Read metadata JSON from file")
    .option("--force", "Overwrite existing stored credentials")
    .action(async (options: RegisterOptions) => {
      try {
        const existing = credentials.get();
        if (existing && !options.force) {
          throw new Error("Stored credentials already exist. Re-run with --force to replace them.");
        }

        const metadata = parseOptionalJson(options.metadata, options.metadataFile);

        output.progress("Generating Ed25519 keypair...");
        const keypair = await generateKeypair();

        output.progress("Requesting proof-of-work challenge...");
        const challenge = await apiRequest<ChallengeResponse>("/auth/challenge", {
          method: "POST",
          body: JSON.stringify({ public_key: keypair.publicKey }),
        });

        output.progress(`Solving proof-of-work challenge (difficulty ${challenge.difficulty})...`);
        const solution = await solveChallenge(
          challenge.nonce,
          keypair.publicKey,
          challenge.difficulty,
        );

        output.progress("Signing challenge nonce...");
        const signature = await signMessage(challenge.nonce, keypair.privateKey);

        output.progress("Registering agent...");
        const result = await apiRequest<RegisterResponse>("/auth/register", {
          method: "POST",
          body: JSON.stringify({
            public_key: keypair.publicKey,
            nonce: challenge.nonce,
            signature,
            solution,
            ...(options.name ? { name: options.name } : {}),
            ...(metadata ? { metadata } : {}),
          }),
        });

        credentials.save({
          apiKey: result.api_key,
          keyPrefix: result.key_prefix,
          entityId: result.entity.id,
          publicKey: keypair.publicKey,
          privateKey: keypair.privateKey,
        });

        output.result({
          operation: "auth.register",
          entity_id: result.entity.id,
          key_prefix: result.key_prefix,
          api_key: result.api_key,
          credentials_path: credentials.path(),
          public_key: keypair.publicKey,
        });
      } catch (error) {
        output.error(error, { operation: "auth.register" });
        process.exitCode = 1;
      }
    });

  auth
    .command("recover")
    .description("Recover API access using the locally stored identity key")
    .action(async () => {
      try {
        const identity = credentials.getIdentity();
        if (!identity?.publicKey || !identity.privateKey) {
          throw new Error("No stored identity key found. Registration is required before recovery.");
        }

        const timestamp = new Date().toISOString();
        const payload = JSON.stringify({ action: "recover", timestamp });
        const signature = await signMessage(payload, identity.privateKey);

        output.progress("Recovering API access...");
        const result = await apiRequest<RecoverResponse>("/auth/recover", {
          method: "POST",
          body: JSON.stringify({
            public_key: identity.publicKey,
            signature,
            timestamp,
          }),
        });

        credentials.save({
          apiKey: result.api_key,
          keyPrefix: result.key_prefix,
          entityId: result.entity_id,
          publicKey: identity.publicKey,
          privateKey: identity.privateKey,
        });

        output.result({
          operation: "auth.recover",
          entity_id: result.entity_id,
          key_prefix: result.key_prefix,
          api_key: result.api_key,
          credentials_path: credentials.path(),
          public_key: identity.publicKey,
        });
      } catch (error) {
        output.error(error, { operation: "auth.recover" });
        process.exitCode = 1;
      }
    });

  auth
    .command("set-api-key")
    .description("Store an API key locally")
    .argument("<key>", "API key")
    .action((key: string) => {
      credentials.save({
        apiKey: key,
        keyPrefix: key.slice(0, 8),
      });
      output.result({
        operation: "auth.set-api-key",
        key_prefix: key.slice(0, 8),
        credentials_path: credentials.path(),
      });
    });

  auth
    .command("status")
    .alias("whoami")
    .description("Show current identity — profile-aware when in a repo")
    .action(async () => {
      try {
        const state = loadRepoState();
        if (state) {
          // Repo context — show profile info
          const actorName = state.current_actor ?? "ingestor";
          const apiUrl = state.api_url;
          const entry = getInstanceActor(apiUrl, actorName) ?? state.actors?.[actorName];
          const actorId = entry?.actor_id ?? null;
          const key = actorId ? credentials.getActorKey(actorId) : null;

          output.result({
            operation: "auth.status",
            source: "profile",
            profile: actorName,
            actor_id: actorId,
            authenticated: Boolean(key),
            key_prefix: key ? `${key.slice(0, 8)}...` : null,
            api_url: state.api_url,
            space_id: state.space_id,
            credentials_path: credentials.path(),
          });
          return;
        }

        // Not in a repo — global identity
        const stored = credentials.get();
        const apiKey = credentials.getApiKey();
        output.result({
          operation: "auth.status",
          source: "global",
          authenticated: Boolean(apiKey),
          has_identity_key: Boolean(stored?.privateKey),
          key_prefix: apiKey ? `${apiKey.slice(0, 8)}...` : null,
          entity_id: stored?.entityId ?? null,
          credentials_path: credentials.path(),
        });
      } catch (error) {
        output.error(error, { operation: "auth.status" });
        process.exitCode = 1;
      }
    });

  auth
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      credentials.clear();
      output.result({
        operation: "auth.logout",
        cleared: true,
        credentials_path: credentials.path(),
      });
    });

  // ── Profile commands (repo-scoped) ──────────────────────────────────
  // `auth me` is auto-generated from GET /auth/me — shows server identity.
  // `auth status` / `auth whoami` (above) shows the local profile context.

  auth
    .command("use")
    .description("Switch the active profile for this repo")
    .argument("<name>", "Profile name (e.g. admin, ingestor)")
    .action(async (name: string) => {
      try {
        const state = loadRepoState();
        if (!state) throw new Error("Not in an initialized repo. Run `arkeon init` first.");

        const apiUrl = state.api_url;
        const entry = getInstanceActor(apiUrl, name) ?? state.actors?.[name];
        if (!entry) {
          const available = Object.keys(listInstanceActors(apiUrl));
          throw new Error(
            `Profile "${name}" not found for this instance. Available: ${available.join(", ") || "(none)"}.\nRun \`arkeon auth add ${name}\` to create it.`,
          );
        }

        state.current_actor = name;
        saveRepoState(state);

        output.result({
          operation: "auth.use",
          profile: name,
          actor_id: entry.actor_id,
        });
      } catch (error) {
        output.error(error, { operation: "auth.use" });
        process.exitCode = 1;
      }
    });

  auth
    .command("add")
    .description("Create a new actor on the graph and register it as a local profile")
    .argument("<name>", "Profile name (e.g. ingestor, reviewer)")
    .option("--kind <kind>", "Actor kind (only 'agent' is supported)", "agent")
    .option("--properties <json>", "Properties JSON")
    .action(async (name: string, opts: { kind: string; properties?: string }) => {
      try {
        const state = loadRepoState();
        if (!state) throw new Error("Not in an initialized repo. Run `arkeon init` first.");

        const apiUrl = state.api_url;
        const existing = getInstanceActor(apiUrl, name);
        if (existing) {
          throw new Error(`Profile "${name}" already exists (actor ${existing.actor_id}). Use \`arkeon auth remove ${name}\` first.`);
        }

        const body: Record<string, unknown> = {
          kind: opts.kind,
          properties: opts.properties ? JSON.parse(opts.properties) : { label: name },
        };

        // Creating actors requires admin privileges. Resolve the admin key
        // from the instance registry or the instance's secrets.json.
        const adminEntry = getInstanceActor(apiUrl, "admin");
        const adminKey = adminEntry
          ? credentials.getActorKey(adminEntry.actor_id)
          : null;
        if (!adminKey) {
          throw new Error(
            "Creating actors requires admin privileges. No admin profile found.\n" +
              "Run `arkeon auth use admin` first, or ensure the instance has an admin profile registered.",
          );
        }

        output.progress(`Creating ${opts.kind} actor "${name}"...`);
        const result = await apiRequest<{ actor: { id: string }; api_key: string }>("/actors", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { authorization: `ApiKey ${adminKey}` },
        });

        const actorId = result.actor.id;
        credentials.saveActorKey(actorId, result.api_key, name);
        saveInstanceActor(apiUrl, name, actorId);

        output.result({
          operation: "auth.add",
          profile: name,
          actor_id: actorId,
          key_prefix: `${result.api_key.slice(0, 8)}...`,
        });
      } catch (error) {
        output.error(error, { operation: "auth.add" });
        process.exitCode = 1;
      }
    });

  auth
    .command("remove")
    .description("Remove a profile from the CLI (optionally deactivate the graph actor)")
    .argument("<name>", "Profile name to remove")
    .option("--delete", "Also deactivate the actor on the graph")
    .action(async (name: string, opts: { delete?: boolean }) => {
      try {
        const state = loadRepoState();
        if (!state) throw new Error("Not in an initialized repo. Run `arkeon init` first.");

        if (state.current_actor === name) {
          throw new Error(`Cannot remove "${name}" — it is the active profile. Run \`arkeon auth use <other>\` first.`);
        }

        const apiUrl = state.api_url;
        const entry = getInstanceActor(apiUrl, name) ?? state.actors?.[name];
        if (!entry) {
          throw new Error(`Profile "${name}" not found.`);
        }

        if (opts.delete) {
          output.progress(`Deactivating actor ${entry.actor_id} on the graph...`);
          await apiRequest(`/actors/${entry.actor_id}`, { method: "DELETE", auth: true });
        }

        removeInstanceActor(apiUrl, name);
        credentials.deleteActorKey(entry.actor_id);

        // Clean up legacy state.actors if present
        if (state.actors?.[name]) {
          delete state.actors[name];
          saveRepoState(state);
        }

        output.result({
          operation: "auth.remove",
          profile: name,
          actor_id: entry.actor_id,
          deactivated: opts.delete ?? false,
        });
      } catch (error) {
        output.error(error, { operation: "auth.remove" });
        process.exitCode = 1;
      }
    });

  auth
    .command("profiles")
    .description("List profiles registered for the current instance")
    .action(() => {
      try {
        const state = loadRepoState();
        if (!state) throw new Error("Not in an initialized repo. Run `arkeon init` first.");

        const apiUrl = state.api_url;
        const actors = listInstanceActors(apiUrl);
        const currentActor = state.current_actor ?? "ingestor";

        const profiles = Object.entries(actors).map(([name, entry]) => {
          const key = credentials.getActorKey(entry.actor_id);
          return {
            name,
            actor_id: entry.actor_id,
            key_prefix: key ? `${key.slice(0, 8)}...` : "(no key)",
            active: name === currentActor,
          };
        });

        output.result({
          operation: "auth.profiles",
          instance: state.api_url,
          current: currentActor,
          profiles,
        });
      } catch (error) {
        output.error(error, { operation: "auth.profiles" });
        process.exitCode = 1;
      }
    });
}
