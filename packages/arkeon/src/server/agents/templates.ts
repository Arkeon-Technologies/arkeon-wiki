// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bundled agent role templates.
 *
 * The runtime ships a handful of ready-to-use roles (ingestor,
 * consolidator) as YAML files under templates/. They are loaded
 * fresh from disk on every call — no in-memory cache. That keeps
 * editing a template + re-running an agent a one-step loop and
 * matches the "filesystem is source of truth" contract for everything
 * else in the project.
 *
 * Resolution layers (lowest to highest precedence) in buildAgentRole:
 *   1. config.defaults              ← agents.yaml `defaults:`
 *   2. bundled templates            ← THIS FILE
 *   3. config.roles[name]           ← agents.yaml `roles:`
 *
 * Bundled templates supply the workflow defaults (system prompt,
 * tools, phases, triggers). Users override individual fields in
 * `.arkeon/agents.yaml` without re-stating the prompts.
 *
 * To add a template: drop a YAML file in templates/ named after the
 * role. Its contents must satisfy ROLE_CONFIG_SCHEMA. No registration
 * needed — the loader enumerates the directory each call.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { ROLE_CONFIG_SCHEMA, type RoleConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Probe candidate directories for `*.yaml` template files. Two cases,
 * mirroring the schema-loader pattern:
 *
 *   - dev (tsx): `__dirname` resolves to src/server/agents/, so the
 *     templates live at src/server/agents/templates/.
 *   - published tarball: tsup bundles the runtime into dist/index.js
 *     and `__dirname` is dist/. The build copies templates to
 *     dist/agent-templates/ via scripts/copy-agent-templates.ts.
 */
function locateTemplatesDir(): string | null {
  const candidates = [
    join(__dirname, "templates"), // dev: src/server/agents/templates
    join(__dirname, "agent-templates"), // tarball: dist/agent-templates
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load every bundled template into a `{ name: RoleConfig }` map. Reads
 * from disk every call — cheap and keeps the loop tight when authoring
 * templates.
 *
 * The role name is the basename of the YAML file (e.g. `ingestor.yaml`
 * → `ingestor`). Files that fail YAML parse or schema validation throw
 * with a clear error pointing at the offending file.
 */
export function loadBundledTemplates(): Record<string, RoleConfig> {
  const dir = locateTemplatesDir();
  if (!dir) return {};

  const out: Record<string, RoleConfig> = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const name = entry.replace(/\.ya?ml$/, "");
    const path = join(dir, entry);
    let parsed: unknown;
    try {
      parsed = yaml.load(readFileSync(path, "utf-8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Bundled template ${path} is not valid YAML: ${msg}`);
    }
    if (parsed === null || parsed === undefined) continue;
    out[name] = ROLE_CONFIG_SCHEMA.parse(parsed);
  }
  return out;
}
