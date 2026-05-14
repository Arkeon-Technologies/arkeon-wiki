// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Service install/uninstall facade.
 *
 * Picks the right supervisor for the current platform (launchd on
 * macOS, systemd on Linux). Both implement the same {@link
 * ServiceManager} interface so the install/uninstall CLI commands stay
 * platform-agnostic.
 *
 * `ARKEON_WIKI_FORCE_PLATFORM=launchd|systemd|unsupported` overrides
 * the auto-detect — used by unit tests to drive the macOS code path
 * from Linux CI runners (and vice versa) without faking process.platform.
 */

import { platform as osPlatform } from "node:os";

import type { Platform, ServiceManager } from "./types.js";

export * from "./types.js";
export { snapshotPaths } from "./path-snapshot.js";
export { snapshotEnv, readEnvKeys } from "./env-snapshot.js";

/**
 * Detect which service supervisor we should target. Pure: only reads
 * `process.platform` and the override env var.
 */
export function detectPlatform(): Platform {
  const override = process.env.ARKEON_WIKI_FORCE_PLATFORM;
  if (override === "launchd" || override === "systemd" || override === "unsupported") {
    return override;
  }
  const p = osPlatform();
  if (p === "darwin") return "launchd";
  if (p === "linux") return "systemd";
  return "unsupported";
}

/**
 * Get the platform's {@link ServiceManager}. Throws on `unsupported` —
 * the install command catches and prints a friendly message.
 *
 * Implementations are loaded lazily via dynamic import so the launchd
 * module never executes on Linux (it's pure rendering today, but as
 * soon as we add `execFile("launchctl", ...)` we want that import to
 * stay off the Linux path entirely).
 */
export async function getServiceManager(p: Platform = detectPlatform()): Promise<ServiceManager> {
  if (p === "launchd") {
    // Phase C wires this up; until then the module exports a
    // not-yet-implemented stub that throws on use.
    const mod = await import("./launchd.js");
    return mod.manager;
  }
  if (p === "systemd") {
    // PR2 wires this up.
    throw new Error(
      "systemd integration is not implemented in this build. " +
        "See https://github.com/Arkeon-Technologies/arkeon-wiki/issues/146",
    );
  }
  throw new Error(
    `Service install is not supported on this platform (${osPlatform()}). ` +
      "Currently supported: macOS (launchd), Linux (systemd, planned).",
  );
}
