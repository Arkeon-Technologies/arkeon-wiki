// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki install-deps` — removed.
 *
 * Binary extractor dependencies (PyMuPDF for PDFs, future libreoffice /
 * pandoc / tesseract / etc.) are now baked into the official Docker
 * image. The host-side Python venv bootstrap has been deleted.
 *
 * The command is kept so existing scripts that call it get a clear
 * pointer instead of a "command not found", but it exits non-zero to
 * fail CI checks loudly.
 */

import type { Command } from "commander";

import { output } from "../../lib/output.js";

const IMAGE_REF = "ghcr.io/arkeon-technologies/arkeon-wiki";

export function registerInstallDepsCommand(program: Command): void {
  program
    .command("install-deps")
    .description(
      "Removed — binary extractor dependencies now ship in the Docker image.",
    )
    .option(
      "--check",
      "(removed) accepted for compatibility; exits non-zero unconditionally.",
    )
    .action(() => {
      output.error(
        new Error(
          "`arkeon-wiki install-deps` has been removed. " +
            "Binary extractors (PDF, etc.) now ship pre-installed in the " +
            `Docker image: ${IMAGE_REF}. ` +
            "See README.md for the docker-compose example.",
        ),
        { operation: "install-deps" },
      );
      process.exitCode = 1;
    });
}
