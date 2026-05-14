// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase A stub. Phase B replaces the body with the plist renderer;
 * Phase C wires bootstrap / bootout / kickstart against launchctl.
 *
 * Exporting the stub here keeps the dynamic import in `index.ts`
 * typecheck-clean before the real implementation lands, and surfaces a
 * clear "not yet implemented" error if someone tries to call it.
 */

import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceStatus,
  UninstallOptions,
  UninstallResult,
} from "./types.js";

function notYetImplemented(name: string): never {
  throw new Error(
    `service.launchd.${name}: not yet implemented in this build ` +
      "(arrives in Phase B/C of the install-service feature).",
  );
}

export const manager: ServiceManager = {
  install(_opts: InstallOptions): Promise<InstallResult> {
    notYetImplemented("install");
  },
  uninstall(_opts: UninstallOptions): Promise<UninstallResult> {
    notYetImplemented("uninstall");
  },
  status(_opts: { name: string }): Promise<ServiceStatus> {
    notYetImplemented("status");
  },
};
