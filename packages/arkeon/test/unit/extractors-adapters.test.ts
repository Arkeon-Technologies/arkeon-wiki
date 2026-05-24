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
  writeAdaptersManifest,
} from "../../src/server/extractors/adapters.js";
import type { AdaptersManifest } from "../../src/server/extractors/types.js";

let savedHome: string | undefined;
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
  process.env.ARKEON_WIKI_HOME = workdir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.ARKEON_WIKI_HOME;
  else process.env.ARKEON_WIKI_HOME = savedHome;
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

  it("writeAdaptersManifest + readAdaptersManifest round-trips", () => {
    const path = writeAdaptersManifest(SAMPLE);
    expect(path).toBe(join(workdir, "adapters.json"));
    const loaded = readAdaptersManifest();
    expect(loaded).toEqual(SAMPLE);
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
