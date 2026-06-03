// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AdaptersManifestMissingError,
  adaptersManifestPath,
  readAdaptersManifest,
  requireAdaptersManifest,
} from "../../src/server/extractors/adapters.js";
import type { AdaptersManifest } from "../../src/server/extractors/types.js";

let savedHome: string | undefined;
let savedAdaptersPath: string | undefined;
let workdir: string;

const SAMPLE: AdaptersManifest = {
  schema_version: 1,
  python: { path: "/tmp/python", version: "3.12.5" },
  system_binaries: { pandoc: { path: "/opt/pandoc", version: "3.5" } },
  python_packages: { pymupdf: { version: "1.24.10" } },
  generated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-adapters-"));
  savedHome = process.env.ARKEON_WIKI_HOME;
  savedAdaptersPath = process.env.ARKEON_WIKI_ADAPTERS_PATH;
  process.env.ARKEON_WIKI_HOME = workdir;
  // Ensure the override doesn't leak in from the runtime env (the
  // Docker image sets it); these tests exercise the host-side path
  // resolution.
  delete process.env.ARKEON_WIKI_ADAPTERS_PATH;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.ARKEON_WIKI_HOME;
  else process.env.ARKEON_WIKI_HOME = savedHome;
  if (savedAdaptersPath === undefined)
    delete process.env.ARKEON_WIKI_ADAPTERS_PATH;
  else process.env.ARKEON_WIKI_ADAPTERS_PATH = savedAdaptersPath;
  rmSync(workdir, { recursive: true, force: true });
});

describe("adapters manifest", () => {
  it("adaptersManifestPath returns path under arkeon home", () => {
    expect(adaptersManifestPath()).toBe(join(workdir, "adapters.json"));
  });

  it("readAdaptersManifest returns null when file is missing", () => {
    expect(readAdaptersManifest()).toBeNull();
  });

  it("requireAdaptersManifest throws AdaptersManifestMissingError on miss", () => {
    expect(() => requireAdaptersManifest()).toThrow(
      AdaptersManifestMissingError,
    );
  });

  it("reads a manifest written to the resolved path", () => {
    writeFileSync(
      join(workdir, "adapters.json"),
      JSON.stringify(SAMPLE, null, 2),
    );
    expect(readAdaptersManifest()).toEqual(SAMPLE);
  });

  it("ARKEON_WIKI_ADAPTERS_PATH overrides the resolved path", () => {
    const overrideDir = mkdtempSync(join(tmpdir(), "arkeon-adapters-ovr-"));
    const overridePath = join(overrideDir, "baked.json");
    process.env.ARKEON_WIKI_ADAPTERS_PATH = overridePath;
    try {
      expect(adaptersManifestPath()).toBe(overridePath);
      writeFileSync(overridePath, JSON.stringify(SAMPLE));
      expect(readAdaptersManifest()).toEqual(SAMPLE);
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it("rejects manifests with an unsupported schema_version", () => {
    writeFileSync(
      join(workdir, "adapters.json"),
      JSON.stringify({ ...SAMPLE, schema_version: 99 }),
    );
    expect(() => readAdaptersManifest()).toThrow(
      /schema_version 99 is not supported/,
    );
  });

  it("rejects unparseable JSON with a contextual error", () => {
    writeFileSync(join(workdir, "adapters.json"), "{not json");
    expect(() => readAdaptersManifest()).toThrow(/failed to read adapters manifest/);
  });
});
