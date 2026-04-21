// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";

import {
  contentHash,
  loadManifest,
  saveManifest,
  type Manifest,
} from "../../src/cli/lib/manifest";

// Mock external dependencies so the pull command runs without a real server
vi.mock("../../src/cli/lib/api-client", () => ({
  apiGet: vi.fn(),
}));

vi.mock("../../src/cli/lib/repo-state", () => ({
  requireRepoState: vi.fn(),
}));

vi.mock("../../src/cli/lib/credentials", () => ({
  credentials: {
    requireActorKey: vi.fn().mockReturnValue("fake-key"),
  },
}));

import { apiGet } from "../../src/cli/lib/api-client";
import { requireRepoState } from "../../src/cli/lib/repo-state";
import { registerPullCommand } from "../../src/cli/commands/repo/pull";

function makeEntity(id: string, label: string, ver: number, subjectType = "concept") {
  return {
    id,
    ver,
    kind: "entity",
    type: "wiki",
    properties: { label, subject_type: subjectType, short_description: `About ${label}` },
  };
}

describe("pull: deletion conflict detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `arkeon-pull-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, ".arkeon"), { recursive: true });
    mkdirSync(join(tmpDir, "wiki", "concept"), { recursive: true });

    vi.mocked(requireRepoState).mockReturnValue({
      api_url: "http://localhost:8000",
      space_id: "space-1",
      space_name: "test",
      actors: { ingestor: { actor_id: "actor-1" } },
      created_at: "2026-01-01T00:00:00Z",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function runPull(...args: string[]) {
    const program = new Command();
    registerPullCommand(program);
    // Simulate running from tmpDir
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    const promise = program.parseAsync(["node", "test", "pull", ...args]);
    return promise.finally(() => process.chdir(origCwd));
  }

  test("deletes unmodified local file when entity removed remotely", async () => {
    // Set up: a synced file that hasn't been locally modified
    const filePath = "wiki/concept/entropy.md";
    const content = "---\nid: ent-1\nver: 1\n---\n# Entropy\n";
    writeFileSync(join(tmpDir, filePath), content);

    const manifest: Manifest = {
      version: 1,
      entries: {
        [filePath]: {
          entity_id: "ent-1",
          ver: 1,
          content_hash: contentHash(join(tmpDir, filePath)),
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    };
    saveManifest(manifest, tmpDir);

    // Remote returns no entities (ent-1 was deleted)
    vi.mocked(apiGet).mockResolvedValue({ entities: [], cursor: null });

    await runPull();

    // File should be deleted
    expect(existsSync(join(tmpDir, filePath))).toBe(false);
    // Manifest entry should be removed
    const updated = loadManifest(tmpDir);
    expect(updated.entries[filePath]).toBeUndefined();
  });

  test("skips deletion of locally modified file (conflict)", async () => {
    // Set up: a synced file
    const filePath = "wiki/concept/entropy.md";
    const originalContent = "---\nid: ent-1\nver: 1\n---\n# Entropy\n";
    writeFileSync(join(tmpDir, filePath), originalContent);

    const manifest: Manifest = {
      version: 1,
      entries: {
        [filePath]: {
          entity_id: "ent-1",
          ver: 1,
          content_hash: contentHash(join(tmpDir, filePath)),
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    };
    saveManifest(manifest, tmpDir);

    // Now locally modify the file
    writeFileSync(join(tmpDir, filePath), originalContent + "\nLocal edits here.\n");

    // Remote returns no entities (ent-1 was deleted)
    vi.mocked(apiGet).mockResolvedValue({ entities: [], cursor: null });

    await runPull();

    // File should still exist — conflict prevents deletion
    expect(existsSync(join(tmpDir, filePath))).toBe(true);
    // Content should be preserved
    const current = readFileSync(join(tmpDir, filePath), "utf-8");
    expect(current).toContain("Local edits here.");
    // Manifest entry should still be present (not removed)
    const updated = loadManifest(tmpDir);
    expect(updated.entries[filePath]).toBeDefined();
  });

  test("--force deletes locally modified file when entity removed remotely", async () => {
    const filePath = "wiki/concept/entropy.md";
    const originalContent = "---\nid: ent-1\nver: 1\n---\n# Entropy\n";
    writeFileSync(join(tmpDir, filePath), originalContent);

    const manifest: Manifest = {
      version: 1,
      entries: {
        [filePath]: {
          entity_id: "ent-1",
          ver: 1,
          content_hash: contentHash(join(tmpDir, filePath)),
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    };
    saveManifest(manifest, tmpDir);

    // Locally modify the file
    writeFileSync(join(tmpDir, filePath), originalContent + "\nLocal edits here.\n");

    // Remote returns no entities
    vi.mocked(apiGet).mockResolvedValue({ entities: [], cursor: null });

    await runPull("--force");

    // File should be deleted — --force overrides conflict
    expect(existsSync(join(tmpDir, filePath))).toBe(false);
    const updated = loadManifest(tmpDir);
    expect(updated.entries[filePath]).toBeUndefined();
  });

  test("filtered pull skips deletion detection entirely", async () => {
    const filePath = "wiki/concept/entropy.md";
    const content = "---\nid: ent-1\nver: 1\n---\n# Entropy\n";
    writeFileSync(join(tmpDir, filePath), content);

    const manifest: Manifest = {
      version: 1,
      entries: {
        [filePath]: {
          entity_id: "ent-1",
          ver: 1,
          content_hash: contentHash(join(tmpDir, filePath)),
          synced_at: "2026-01-01T00:00:00Z",
        },
      },
    };
    saveManifest(manifest, tmpDir);

    // Remote returns no entities, but we're using a filter
    vi.mocked(apiGet).mockResolvedValue({ entities: [], cursor: null });

    await runPull("--filter", "properties.subject_type:person");

    // File should still exist — filtered pulls don't infer deletions
    expect(existsSync(join(tmpDir, filePath))).toBe(true);
    const updated = loadManifest(tmpDir);
    expect(updated.entries[filePath]).toBeDefined();
  });
});
