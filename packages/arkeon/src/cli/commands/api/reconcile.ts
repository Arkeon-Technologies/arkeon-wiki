// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki reconcile` — POST /reconcile. Force a full re-walk of
 * the watched root + prune orphan rows. Heals dropped watcher events
 * without a daemon restart.
 *
 * The daemon also runs this on a 30s timer in the background; the
 * command is for when you'd rather force the sweep right now (after a
 * bulk `mv` or similar).
 */

import type { Command } from "commander";

import { apiCall } from "../../lib/api-client.js";
import { isTty, printJson, printKeyValue } from "../../lib/format.js";
import {
  addCommonOptions,
  readGlobals,
  transportOptions,
} from "./_globals.js";

interface ReconcileResponse {
  ok: boolean;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
  took_ms: number;
  coalesced: boolean;
}

export function registerReconcileCommand(program: Command): void {
  const cmd = addCommonOptions(
    program
      .command("reconcile")
      .description(
        "Force a full re-walk of the watched root + prune orphan artifact rows",
      ),
  );
  cmd.action(async (_o: unknown, command: Command) => {
    const g = readGlobals(command);
    const result = await apiCall<ReconcileResponse>(
      "POST",
      "/reconcile",
      { body: {} },
      transportOptions(g),
    );
    if (g.json || !isTty()) {
      printJson(result);
      return;
    }
    printKeyValue([
      ["created", String(result.created)],
      ["updated", String(result.updated)],
      ["unchanged", String(result.unchanged)],
      ["removed", String(result.removed)],
      ["failed", String(result.failed)],
      ["took_ms", String(result.took_ms)],
      ["coalesced", String(result.coalesced)],
    ]);
  });
}
