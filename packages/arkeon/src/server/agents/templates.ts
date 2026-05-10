// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bundled agent role templates.
 *
 * The runtime ships a handful of ready-to-use roles (ingestor,
 * consolidator) as YAML files under templates/. The loader is on the
 * agent-claim hot path (every queue claim calls buildAgentRole, which
 * calls loadBundledTemplates), so we mtime-cache parsed configs:
 * readdir + stat each call (kernel-cached, sub-microsecond), reload +
 * Zod-parse only on mtime change. Editing a template still picks up
 * on the next call — the dev loop stays a one-step edit-and-re-run.
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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

interface CacheEntry {
  mtimeMs: number;
  config: RoleConfig;
}

/** Per-path cache. Keys are absolute paths so the entry survives any
 *  dev/tarball relocation (the locator returns one or the other but
 *  not both within a single process). */
const cache = new Map<string, CacheEntry>();

/**
 * Load every bundled template into a `{ name: RoleConfig }` map.
 *
 * Cache strategy: readdir the templates directory each call (kernel-
 * cached, microseconds), stat each YAML for its mtime, and reuse the
 * parsed config when the mtime is unchanged. A touched file invalidates
 * only itself; deleted files drop from the cache once they stop showing
 * up in readdir. Cost on a hot-path claim with no edits: 1× readdirSync
 * + N× statSync. Cost on first call or after an edit: + readFileSync,
 * yaml.load, and ROLE_CONFIG_SCHEMA.parse for the changed file(s).
 *
 * The role name is the basename of the YAML file (e.g. `ingestor.yaml`
 * → `ingestor`). Files that fail YAML parse or schema validation throw
 * with a clear error pointing at the offending file.
 */
export function loadBundledTemplates(): Record<string, RoleConfig> {
  const dir = locateTemplatesDir();
  if (!dir) {
    cache.clear();
    return {};
  }

  const out: Record<string, RoleConfig> = {};
  const seen = new Set<string>();

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const name = entry.replace(/\.ya?ml$/, "");
    const path = join(dir, entry);
    seen.add(path);

    const mtimeMs = statSync(path).mtimeMs;
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      out[name] = cached.config;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(readFileSync(path, "utf-8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Bundled template ${path} is not valid YAML: ${msg}`);
    }
    if (parsed === null || parsed === undefined) {
      // Empty file — skip and DON'T cache, so a meaningful edit later
      // doesn't get short-circuited by a stale "absent" entry. (We can't
      // cache `undefined` in the Map and distinguish from "missing".)
      cache.delete(path);
      continue;
    }
    const config = ROLE_CONFIG_SCHEMA.parse(parsed);
    cache.set(path, { mtimeMs, config });
    out[name] = config;
  }

  // Drop cache entries for files that have disappeared (renamed,
  // deleted) so the cache doesn't grow unbounded across long-running
  // daemons that occasionally rotate templates.
  for (const path of cache.keys()) {
    if (!seen.has(path)) cache.delete(path);
  }

  return out;
}
