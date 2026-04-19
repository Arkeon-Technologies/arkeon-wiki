// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon init` — create ~/.arkeon-wiki, generate secrets, optionally stage
 * LLM config. Does not start services.
 *
 * Flow:
 *   1. ensureArkeonDir() — make the state directory tree
 *   2. If --force, wipe any existing secrets.json so loadOrCreateSecrets
 *      rotates everything
 *   3. loadOrCreateSecrets() — generate or read back the admin key, pg
 *      password, encryption key, meili key
 *   4. Validate --llm-* flags (all-or-nothing, base-url must parse)
 *   5. If flags produced a config, write it to pending-llm.json (0600);
 *      otherwise clear any stale pending file so a fresh init resets LLM
 *   6. Print a JSON result with the state dir, admin key prefix, and
 *      whether an LLM config is staged
 */

import type { Command } from "commander";
import { existsSync, unlinkSync } from "node:fs";

import {
  arkeonDir,
  clearLlmConfig,
  ensureArkeonDir,
  loadOrCreateSecrets,
  secretsFile,
  writeLlmConfig,
} from "../../lib/local-runtime.js";
import { buildLlmConfigFromFlags, type InitLlmFlags } from "../../lib/local.js";
import { output } from "../../lib/output.js";

interface InitOptions extends InitLlmFlags {
  force?: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create ~/.arkeon-wiki, generate secrets, optionally stage an LLM provider config")
    .option("--force", "Rotate all secrets even if ~/.arkeon-wiki/secrets.json already exists")
    .option(
      "--llm-provider <name>",
      "LLM provider label (free-form, e.g. openai, anthropic, openrouter, local)",
    )
    .option(
      "--llm-base-url <url>",
      "OpenAI-compatible base URL (e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1)",
    )
    .option("--llm-api-key <key>", "API key for the LLM provider")
    .option(
      "--llm-model <model>",
      "Model identifier (e.g. gpt-4.1-nano, claude-3-5-sonnet-20241022)",
    )
    .addHelpText(
      "after",
      "\nLLM flags: pass all four of --llm-provider, --llm-base-url, --llm-api-key, --llm-model\n" +
        "together to pre-configure LLM access for wiki link resolution. Omit them entirely to skip.",
    )
    .action(async (opts: InitOptions) => {
      try {
        // Validate LLM flags up front so we don't touch the state dir
        // and then fail on the LLM step — all-or-nothing validation
        // keeps init atomic.
        const llm = buildLlmConfigFromFlags(opts);

        ensureArkeonDir();

        // --force rotates: nuke the existing secrets.json so
        // loadOrCreateSecrets generates fresh ones. Data stays put —
        // use `arkeon reset` if you want to wipe that too.
        if (opts.force && existsSync(secretsFile())) {
          unlinkSync(secretsFile());
        }

        const secrets = loadOrCreateSecrets();

        if (llm) {
          writeLlmConfig(llm);
        } else {
          // Ensure no stale config survives a re-init without LLM flags —
          // the user probably wants a clean slate.
          clearLlmConfig();
        }

        output.result({
          operation: "init",
          state_dir: arkeonDir(),
          admin_key_prefix: `${secrets.adminBootstrapKey.slice(0, 8)}...`,
          rotated: Boolean(opts.force),
          llm_configured: llm?.default
            ? { provider: llm.default.provider, base_url: llm.default.base_url, model: llm.default.model }
            : null,
          llm_hint: llm
            ? "Per-step overrides (resolve/exists/draft/dedup) can be hand-edited in ~/.arkeon-wiki/llm.json."
            : "No LLM provider configured. Pass --llm-provider, --llm-base-url, --llm-api-key, --llm-model to stage one.",
          next: "arkeon up",
        });
      } catch (error) {
        output.error(error, { operation: "init" });
        process.exitCode = 1;
      }
    });
}
