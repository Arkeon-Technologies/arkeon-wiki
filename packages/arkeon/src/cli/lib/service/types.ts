// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the service install/uninstall surface. Platforms
 * (launchd on macOS, systemd on Linux) implement {@link ServiceManager}
 * and the {@link detectPlatform} dispatch picks one at runtime.
 *
 * Everything here is pure data — no Node-side filesystem or process
 * calls. The launchd / systemd modules import from this file to keep
 * their public shape uniform.
 */

/**
 * Snapshot of the absolute paths the supervisor needs to invoke the
 * daemon. Resolved at install time so the unit/plist doesn't depend on
 * the user's interactive PATH (nvm/fnm change the resolved `node`
 * binary on every shell init; pinning the absolute path at install
 * time means the service keeps working even if the user later changes
 * shell defaults).
 */
export interface PathSnapshot {
  /** Absolute path to the node binary. From `process.execPath`. */
  nodeBin: string;
  /** Absolute path to the CLI entry script (dist/index.js in prod, src in dev). */
  cliEntry: string;
}

export interface InstallOptions {
  /** Instance name. "default" for the unnamed install. */
  name: string;
  /** Resolved instance home (~/.arkeon-wiki or ~/.arkeon-wiki/<name>). */
  home: string;
  /** Pinned-at-install-time node + entry paths. */
  paths: PathSnapshot;
}

export interface InstallResult {
  /** Filesystem path of the plist or unit we wrote. */
  unitPath: string;
  /** "tech.arkeon.wiki" or "arkeon-wiki@<name>" — the supervisor's handle. */
  label: string;
  /** True if the supervisor reports the service running after install. */
  running: boolean;
  /** PID, if the supervisor exposes one. */
  pid: number | null;
  /**
   * Linux-only: did `loginctl enable-linger <user>` succeed? Headless
   * servers need linger enabled for the user-systemd instance to
   * survive logout. Best-effort during install (polkit may refuse on
   * some distros), so we report the outcome rather than failing.
   * Undefined on launchd.
   */
  lingerEnabled?: boolean;
}

export interface UninstallOptions {
  name: string;
}

export interface UninstallResult {
  /** True if we found and removed a unit file. False is fine — idempotent. */
  removed: boolean;
  /** Path of the unit we removed, if any. */
  unitPath: string | null;
}

export interface ServiceStatus {
  /** True if a unit/plist exists on disk for this name. */
  installed: boolean;
  /** True if the supervisor reports the service running. */
  running: boolean;
  /** PID per the supervisor's view, if any. */
  pid: number | null;
  /** Path of the unit/plist on disk, if installed. */
  unitPath: string | null;
}

export interface StartResult {
  /** True if the supervisor reports the service running after the call. */
  running: boolean;
  /** PID per the supervisor, if any. */
  pid: number | null;
  /** Path of the unit/plist the supervisor is managing. */
  unitPath: string;
}

/**
 * Per-platform surface. `launchd.ts` and `systemd.ts` each export a
 * `manager: ServiceManager` that satisfies this interface.
 *
 * `start()` is the "bring an already-installed service up" operation
 * — distinct from `install()` which also writes the plist/unit. Used
 * by `arkeon-wiki up` to delegate to the supervisor instead of
 * spawning a detached child that the supervisor doesn't track.
 */
export interface ServiceManager {
  install(opts: InstallOptions): Promise<InstallResult>;
  uninstall(opts: UninstallOptions): Promise<UninstallResult>;
  status(opts: { name: string }): Promise<ServiceStatus>;
  start(opts: { name: string }): Promise<StartResult>;
}

export type Platform = "launchd" | "systemd" | "unsupported";
