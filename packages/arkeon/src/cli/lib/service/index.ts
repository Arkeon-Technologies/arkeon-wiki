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

import type { Platform, ServiceManager, ServiceStatus } from "./types.js";

export * from "./types.js";
export { snapshotPaths } from "./path-snapshot.js";
export { snapshotEnv, readEnvKeys } from "./env-snapshot.js";
export {
  DEFAULT_LAUNCHD_LABEL,
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
  validateInstanceName,
} from "./launchd-plist.js";
export {
  renderSystemdUnit,
  systemdUnitName,
  systemdUnitPath,
  UNIT_PREFIX as SYSTEMD_UNIT_PREFIX,
} from "./systemd-unit.js";

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
 * If a service is installed for the given instance, return its status
 * + the platform's manager. Returns null on unsupported platforms,
 * when no service is registered for this name, or when status query
 * fails for any reason.
 *
 * Used by `up`, `down`, and `status` to coordinate with the
 * supervisor: if a service exists, the supervisor owns the daemon's
 * lifecycle and the CLI delegates to it instead of spawning a
 * detached child the supervisor doesn't track.
 *
 * Failing closed (return null on any error) is deliberate. The
 * fallback in callers is "behave like there's no service" — the
 * pre-install behavior. We never want a transient launchctl glitch to
 * make `up` refuse to start.
 */
export async function findInstalledService(name: string): Promise<{
  manager: ServiceManager;
  status: ServiceStatus;
} | null> {
  const platform = detectPlatform();
  if (platform === "unsupported") return null;
  try {
    const manager = await getServiceManager(platform);
    const status = await manager.status({ name });
    if (!status.installed) return null;
    return { manager, status };
  } catch {
    return null;
  }
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
