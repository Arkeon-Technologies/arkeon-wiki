// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-agnostic naming helpers shared by both launchd and systemd
 * renderers. The character set + default-name sentinel are identical
 * on both platforms because they have to satisfy the same constraints:
 * filesystem-safe (unit/plist filenames embed the name) and shell-safe
 * (the name flows into the supervisor's command line as a `--name`
 * argument).
 */

export const DEFAULT_INSTANCE_NAME = "default";

/**
 * Allow only filesystem-safe characters in instance names. Anything
 * outside this set risks shell interpretation in `ProgramArguments`
 * (launchd) / `ExecStart` (systemd), or breaks the unit/plist
 * filename — easier to reject up front than guard every escape
 * boundary.
 */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateInstanceName(name: string): void {
  if (!name) {
    throw new Error("instance name must be non-empty");
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `instance name "${name}" contains characters outside [A-Za-z0-9._-]. ` +
        "Pick a name made of letters, digits, dot, underscore, or hyphen.",
    );
  }
}

export function isDefaultName(name: string): boolean {
  return name === DEFAULT_INSTANCE_NAME;
}
