// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon docs` — auto-generated reference for the CLI, API, and SDK.
 *
 * Walks the Commander program tree to produce a complete CLI reference,
 * uses the OpenAPI snapshot for the API reference, and emits a static
 * SDK quick-reference. Output is plain text optimized for LLM context
 * windows — the CLI equivalent of `/llms.txt`.
 *
 * Formats:
 *   arkeon docs              All sections (CLI + API + SDK)
 *   arkeon docs --format cli CLI commands only
 *   arkeon docs --format api API reference (same as /llms.txt, works offline)
 *   arkeon docs --format sdk SDK quick reference
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, type Option } from "commander";

import {
  WHAT_IS_ARKEON,
  CORE_CONCEPTS,
  AUTHENTICATION,
  BEST_PRACTICES,
  FILTERING_HINT,
  type GeneratedField,
  type GeneratedOperation,
  type OpenAPISpec,
  parseOperations,
  toFlagName,
} from "../../../shared/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandInfo {
  name: string;
  description: string;
  options: { flags: string; description: string; defaultValue?: unknown }[];
  arguments: { name: string; description: string; required: boolean }[];
  /** Present only for auto-generated API commands */
  route?: { method: string; path: string; auth: string };
}

// ---------------------------------------------------------------------------
// Commander tree walker
// ---------------------------------------------------------------------------

/**
 * Locate and load the OpenAPI snapshot. Two layouts:
 *
 *   - dev (tsx): __dirname is packages/arkeon/src/cli/commands/docs,
 *     so we go up 4 levels to packages/arkeon/spec/.
 *   - published tarball: __dirname is packages/arkeon/dist (bundled),
 *     so we look for dist/spec/ (copied by scripts/copy-spec.ts).
 */
function loadSpec(): OpenAPISpec {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, "..", "..", "..", "..", "spec", "openapi.snapshot.json"), // dev
    join(__dirname, "spec", "openapi.snapshot.json"), // bundled dist
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8")) as OpenAPISpec;
    }
  }
  throw new Error(
    `OpenAPI snapshot not found. Searched:\n${candidates.map((c) => `  ${c}`).join("\n")}\n` +
    `Run \`npm run build -w packages/arkeon\` to generate it.`,
  );
}

/**
 * Build a lookup map from "group.action" → operation metadata using
 * the OpenAPI snapshot. This lets us enrich Commander-tree commands
 * with route/auth info without modifying the auto-generated file.
 */
function buildOperationLookup(): Map<string, GeneratedOperation> {
  const spec = loadSpec();
  const operations = parseOperations(spec);
  const map = new Map<string, GeneratedOperation>();
  for (const op of operations) {
    map.set(`${op.group}.${op.action}`, op);
  }
  return map;
}

/**
 * Recursively walk a Commander program and collect leaf commands.
 * Groups (commands with sub-commands) are traversed, not emitted.
 */
function walkCommands(
  cmd: Command,
  prefix: string = "",
  opLookup?: Map<string, GeneratedOperation>,
): CommandInfo[] {
  const results: CommandInfo[] = [];

  for (const sub of cmd.commands) {
    const fullName = prefix ? `${prefix} ${sub.name()}` : sub.name();

    if (sub.commands.length > 0) {
      results.push(...walkCommands(sub, fullName, opLookup));
    } else {
      // Cross-reference with the OpenAPI operations to get route info
      let route: CommandInfo["route"];
      if (opLookup) {
        // fullName is e.g. "entities list" → lookup key "entities.list"
        const parts = fullName.split(" ");
        if (parts.length >= 2) {
          const key = `${parts[0]}.${parts.slice(1).join(".")}`;
          const op = opLookup.get(key);
          if (op) {
            route = { method: op.method, path: op.path, auth: op.auth };
          }
        }
      }

      results.push({
        name: fullName,
        description: sub.description(),
        options: sub.options
          .filter((o: Option) => !o.hidden)
          .map((o: Option) => ({
            flags: o.flags,
            description: o.description,
            defaultValue: o.defaultValue,
          })),
        arguments: sub.registeredArguments.map((a) => ({
          name: a.name(),
          description: a.description,
          required: a.required,
        })),
        route,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI reference renderer
// ---------------------------------------------------------------------------

function renderPreamble(): string {
  return [
    "# Arkeon — Complete Reference",
    "",
    "## What is Arkeon?",
    "",
    WHAT_IS_ARKEON,
    "",
    "## Core Concepts",
    "",
    CORE_CONCEPTS,
    "",
    "## Authentication",
    "",
    AUTHENTICATION,
    "",
    "Set up the CLI:",
    "  arkeon config set-url https://your-instance.arkeon.tech",
    "  arkeon auth set-api-key <your-key>",
    "",
    "Or use environment variables:",
    "  export ARKE_API_URL=https://your-instance.arkeon.tech",
    "  export ARKE_API_KEY=<your-key>",
    "",
    "## Filter Syntax",
    "",
    FILTERING_HINT,
    "",
    "## Best Practices",
    "",
    BEST_PRACTICES,
    "",
  ].join("\n");
}

function renderGlobalOptions(program: Command): string {
  const lines = ["## Global Options", ""];
  for (const opt of program.options) {
    if (opt.hidden) continue;
    const def = opt.defaultValue !== undefined ? ` (default: ${opt.defaultValue})` : "";
    lines.push(`  ${opt.flags.padEnd(30)} ${opt.description}${def}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderCliReference(commands: CommandInfo[]): string {
  // Group by first word of name
  const grouped = new Map<string, CommandInfo[]>();
  for (const cmd of commands) {
    const group = cmd.name.includes(" ") ? cmd.name.split(" ")[0] : "(top-level)";
    const list = grouped.get(group) ?? [];
    list.push(cmd);
    grouped.set(group, list);
  }

  const sections: string[] = ["# CLI Command Reference", ""];

  for (const [group, cmds] of grouped) {
    sections.push(`## ${group}`);
    sections.push("");

    for (const cmd of cmds) {
      const args = cmd.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
      const signature = args ? `arkeon ${cmd.name} ${args}` : `arkeon ${cmd.name}`;

      sections.push(`### ${signature}`);
      if (cmd.route) {
        sections.push(`${cmd.route.method} ${cmd.route.path} | Auth: ${cmd.route.auth}`);
      }
      sections.push(cmd.description);

      if (cmd.arguments.length > 0) {
        sections.push("");
        sections.push("Arguments:");
        for (const arg of cmd.arguments) {
          const req = arg.required ? " (required)" : "";
          sections.push(`  ${arg.name.padEnd(22)} ${arg.description || arg.name}${req}`);
        }
      }

      if (cmd.options.length > 0) {
        sections.push("");
        sections.push("Options:");
        for (const opt of cmd.options) {
          const def = opt.defaultValue !== undefined ? ` (default: ${opt.defaultValue})` : "";
          sections.push(`  ${opt.flags.padEnd(30)} ${opt.description}${def}`);
        }
      }

      sections.push("");
    }
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// API reference renderer (offline, from snapshot)
// ---------------------------------------------------------------------------

function renderApiFieldLine(field: GeneratedField): string {
  const req = field.required ? "*" : "";
  const enumText = field.enumValues?.length ? ` (${field.enumValues.join("|")})` : "";
  const desc = field.description || field.name;
  const name = `${field.name}${req}`;
  return `  ${name.padEnd(22)} ${field.type.padEnd(10)} ${desc}${enumText}`;
}

function renderApiOperation(op: GeneratedOperation): string {
  const lines: string[] = [
    `### ${op.method} ${op.path}`,
    `Auth: ${op.auth}`,
    op.summary,
  ];

  if (op.pathParams.length) {
    lines.push("");
    lines.push("Path params:");
    for (const p of op.pathParams) lines.push(renderApiFieldLine(p));
  }

  if (op.queryParams.length) {
    lines.push("");
    lines.push("Query params:");
    for (const f of op.queryParams) lines.push(renderApiFieldLine(f));
  }

  if (op.bodyFields.length) {
    lines.push("");
    lines.push("Request body (JSON):");
    for (const f of op.bodyFields) lines.push(renderApiFieldLine(f));
  }

  if (op.responseFields.length) {
    lines.push("");
    lines.push("Response:");
    for (const f of op.responseFields) lines.push(renderApiFieldLine(f));
  }

  if (op.rules.length) {
    lines.push("");
    lines.push("Rules:");
    for (const rule of op.rules) lines.push(`  - ${rule}`);
  }

  return lines.join("\n");
}

function renderApiReference(): string {
  const spec = loadSpec();
  const operations = parseOperations(spec);

  const grouped = new Map<string, GeneratedOperation[]>();
  for (const op of operations) {
    const section = op.path.split("/")[1] ?? "other";
    const list = grouped.get(section) ?? [];
    list.push(op);
    grouped.set(section, list);
  }

  const sections: string[] = [
    "# API Reference",
    "",
    "Auth: X-API-Key: <key> (preferred) or Authorization: ApiKey <key>",
    "Detail: GET /help/<METHOD>/<path> for full docs on any route",
    "",
    "IMPORTANT: API responses wrap objects in a named key. Never access .id directly.",
    "Each endpoint below includes a Response section showing the exact field names and types.",
    "  Example: resp.wiki.id (NOT resp.id) — always use the wrapper key first.",
    "",
  ];

  for (const [section, ops] of grouped) {
    sections.push(`## ${section}`);
    sections.push("");
    for (const op of ops) {
      sections.push(renderApiOperation(op));
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// SDK reference renderer
// ---------------------------------------------------------------------------

function renderExplorerReference(): string {
  return [
    "# Explorer & Screenshot Server",
    "",
    "## Graph Explorer",
    "",
    "The Explorer is a browser-based graph visualization served at GET /explore.",
    "It renders entities as a force-directed graph using Sigma.js (WebGL).",
    "",
    "  Open: http://localhost:8000/explore",
    "",
    "URL parameters:",
    "  select=<entity-id>   Pre-select and zoom to an entity",
    "  mode=graph|feed      Graph view or activity feed",
    "  cap=N                Max entities to load (default 3000)",
    "  mock                 Use built-in fixture data (dev only)",
    "",
    "Interaction:",
    "  - Click node: select it, show detail panel with properties/relationships",
    "  - Click edge: select relationship, show triplet view (source -> pred -> target)",
    "  - Hover: pointer cursor, visual highlight, neighbor labels appear",
    "  - Scroll: zoom, drag: pan, click background: deselect",
    "",
    "## Screenshot Server (for LLM agents)",
    "",
    "Renders the explorer in headless Chromium and returns a PNG via HTTP.",
    "",
    "  Start:  node packages/explorer/scripts/screenshot-server.mjs",
    "  Server: http://127.0.0.1:3200/screenshot",
    "",
    "Examples:",
    "  curl http://localhost:3200/screenshot -o /tmp/graph.png",
    "  curl \"http://localhost:3200/screenshot?select=<entity-id>\" -o /tmp/selected.png",
    "  curl \"http://localhost:3200/screenshot?mock\" -o /tmp/mock.png",
    "",
    "Parameters:",
    "  select=<id>   Entity to select and zoom to",
    "  mock          Use mock fixture data (no running instance needed)",
    "  width=N       Viewport width (default 1400, max 3840)",
    "  height=N      Viewport height (default 900, max 2160)",
    "  wait=N        Ms to wait for layout (default 3000, max 10000)",
    "",
    "Environment variables:",
    "  EXPLORER_URL      Explorer base URL (default http://localhost:8000/explore/)",
    "  SCREENSHOT_PORT   Server port (default 3200)",
    "",
    "Agent workflow:",
    "  1. curl http://localhost:3200/screenshot -o /tmp/graph.png",
    "  2. Read /tmp/graph.png (multimodal image inspection)",
    "  3. Assess the visual state of the graph",
    "",
    "Also available at: GET /help/guide/explorer (when instance is running)",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDocsCommand(program: Command): void {
  program
    .command("docs")
    .description("Auto-generated reference for the CLI, API, and explorer")
    .option("--format <format>", "Output section: cli, api, explorer (default: all)")
    .action((options: { format?: string }) => {
      const format = options.format?.toLowerCase();

      if (format && !["cli", "api", "explorer"].includes(format)) {
        process.stderr.write(`Unknown format "${format}". Use: cli, api, explorer\n`);
        process.exitCode = 1;
        return;
      }

      const parts: string[] = [];

      if (!format) {
        parts.push(renderPreamble());
      }

      if (!format || format === "cli") {
        if (!format) parts.push(renderGlobalOptions(program));
        else {
          parts.push(renderPreamble());
          parts.push(renderGlobalOptions(program));
        }
        const opLookup = buildOperationLookup();
        const commands = walkCommands(program, "", opLookup);
        parts.push(renderCliReference(commands));
      }

      if (!format || format === "api") {
        parts.push(renderApiReference());
      }

      if (!format || format === "explorer") {
        parts.push(renderExplorerReference());
      }

      process.stdout.write(parts.join("\n"));
    });
}
