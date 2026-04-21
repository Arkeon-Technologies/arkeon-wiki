// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";

import { config } from "../../lib/config.js";
import { llmConfigFile, probeLlmConfig, workersConfigFile } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command("config").description("CLI configuration");

  configCmd
    .command("set-url")
    .description("Set the API URL (e.g. https://my-instance.arkeon.tech)")
    .argument("<url>", "API base URL")
    .action((url: string) => {
      config.set("apiUrl", url.replace(/\/$/, ""));
      output.result({
        operation: "config.set-url",
        api_url: config.get("apiUrl"),
        config_path: config.path(),
      });
    });

  configCmd
    .command("get-url")
    .description("Show the current API URL")
    .action(() => {
      output.result({
        operation: "config.get-url",
        api_url: config.get("apiUrl"),
        source: process.env.ARKE_API_URL ? "ARKE_API_URL" : "config",
        config_path: config.path(),
      });
    });

  configCmd
    .command("clear-url")
    .description("Reset API URL to the default")
    .action(() => {
      config.delete("apiUrl");
      output.result({
        operation: "config.clear-url",
        api_url: config.get("apiUrl"),
        config_path: config.path(),
      });
    });

  configCmd
    .command("set-space")
    .description("Set the default space ID — entities and relationships will be added to this space on creation")
    .argument("<id>", "Space ULID")
    .action((id: string) => {
      config.set("spaceId", id);
      output.result({
        operation: "config.set-space",
        space_id: id,
        config_path: config.path(),
      });
    });

  configCmd
    .command("get-space")
    .description("Show the current default space ID")
    .action(() => {
      const spaceId = config.get("spaceId");
      output.result({
        operation: "config.get-space",
        space_id: spaceId ?? null,
        source: process.env.ARKE_SPACE_ID ? "ARKE_SPACE_ID" : spaceId ? "config" : null,
        config_path: config.path(),
      });
    });

  configCmd
    .command("clear-space")
    .description("Remove the stored default space ID")
    .action(() => {
      config.delete("spaceId");
      output.result({
        operation: "config.clear-space",
        cleared: true,
        config_path: config.path(),
      });
    });

  configCmd
    .command("show")
    .description("Show all CLI configuration")
    .action(() => {
      const spaceId = config.get("spaceId");
      const llm = probeLlmConfig();
      output.result({
        operation: "config.show",
        api_url: config.get("apiUrl"),
        api_url_source: process.env.ARKE_API_URL ? "ARKE_API_URL" : "config",
        space_id: spaceId ?? null,
        space_id_source: process.env.ARKE_SPACE_ID ? "ARKE_SPACE_ID" : spaceId ? "config" : null,
        llm,
        config_path: config.path(),
      });
    });

  configCmd
    .command("get-llm")
    .description("Show current LLM configuration status")
    .action(() => {
      const llm = probeLlmConfig();
      output.result({
        operation: "config.get-llm",
        ...llm,
        llm_config_path: llmConfigFile(),
        workers_config_path: workersConfigFile(),
        hint: llm.configured
          ? undefined
          : "Set an LLM key with: arkeon-wiki config set-llm-key <your-api-key>",
      });
    });

  configCmd
    .command("set-llm-key")
    .description("Set the LLM API key (writes to llm.json)")
    .argument("<key>", "OpenAI-compatible API key")
    .option("--model <model>", "Default model to use (e.g. gpt-4o, claude-sonnet-4-20250514)")
    .option("--base-url <url>", "Custom base URL for OpenAI-compatible providers")
    .action((key: string, opts: { model?: string; baseUrl?: string }) => {
      const path = llmConfigFile();
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Merge into existing file if present
      let doc: Record<string, unknown> = {};
      if (existsSync(path)) {
        try {
          doc = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
        } catch {
          output.warn(`Existing ${path} is malformed JSON — overwriting with new config.`);
        }
      }

      const def = (doc.default ?? {}) as Record<string, unknown>;
      def.api_key = key;
      if (opts.model) def.model = opts.model;
      if (opts.baseUrl) def.base_url = opts.baseUrl;
      doc.default = def;

      writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf-8");
      output.result({
        operation: "config.set-llm-key",
        key_set: true,
        llm_config_path: path,
        model: def.model ?? null,
        base_url: def.base_url ?? null,
      });
    });
}

