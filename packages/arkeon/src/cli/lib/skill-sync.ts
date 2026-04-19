// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-sync bundled skills on CLI version change.
 *
 * Called from the preAction hook in index.ts. On every invocation,
 * reads ~/.arkeon-wiki/skill-version. If it matches the current CLI version,
 * does nothing (~1ms). If it differs (or doesn't exist), installs skills
 * for all providers and writes the new version stamp.
 *
 * Global providers (Claude, Codex, Gemini) are always synced.
 * Project-local providers (Cursor) are only synced if their output directory
 * already exists in cwd (i.e., the user has previously run `arkeon install`).
 * AGENTS.md is only updated if an arkeon-managed AGENTS.md already exists.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { hasArkeonAgentsMd, individualProviders, installAgentsMd } from "../commands/install/providers.js";

const STAMP_FILE = "skill-version";

function stampPath(): string {
  return join(process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki"), STAMP_FILE);
}

export function syncSkillsIfNeeded(cliVersion: string): void {
  try {
    const path = stampPath();
    if (existsSync(path)) {
      const stamp = readFileSync(path, "utf-8").trim();
      if (stamp === cliVersion) return;
    }

    // Version changed (or first run) — sync providers
    for (const provider of individualProviders) {
      try {
        if (provider.isGlobal) {
          // Global providers: always sync
          provider.install();
        } else {
          // Project-local providers: only sync if output dir already exists
          const dir = provider.skillDir();
          if (dir && existsSync(dir)) {
            provider.install();
          }
        }
      } catch {
        // Non-fatal — don't block CLI usage if skill install fails
      }
    }

    // Update AGENTS.md if one already exists and is arkeon-managed
    try {
      if (hasArkeonAgentsMd()) {
        installAgentsMd();
      }
    } catch {
      // Non-fatal
    }

    // Write version stamp
    const dir = process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki");
    mkdirSync(dir, { recursive: true });
    writeFileSync(stampPath(), cliVersion + "\n");
  } catch {
    // Never let skill sync break the CLI
  }
}
