// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-logic tests for the CWD-walk resolver. The filesystem-touching
 * paths (registry lookups for --name / fallback) are covered indirectly
 * by the e2e suite — here we exercise the resolution rules where the
 * candidate `instances` array is passed in directly.
 */

import { describe, expect, it } from "vitest";

import {
  findInstanceForCwd,
  relativeToWatchDir,
  resolveTarget,
} from "../../src/cli/lib/instance-resolve.js";
import type { Instance } from "../../src/cli/lib/instances.js";

function instance(name: string, watch_dir: string | undefined): Instance {
  return {
    name,
    api_url: `http://localhost:80${name.length.toString().padStart(2, "0")}`,
    api_port: 8000 + name.length,
    home: `/home/.arkeon-wiki/${name}`,
    watch_dir,
    pid: 1234,
    started_at: "2026-06-03T00:00:00.000Z",
  };
}

describe("findInstanceForCwd", () => {
  it("returns null when no instances are registered", () => {
    expect(findInstanceForCwd("/Users/me/work/corpus", [])).toBeNull();
  });

  it("returns null when CWD is not under any instance's watch_dir", () => {
    const insts = [instance("a", "/Users/me/work/corpus-a")];
    expect(findInstanceForCwd("/Users/me/other", insts)).toBeNull();
  });

  it("matches when CWD equals the watch_dir exactly", () => {
    const insts = [instance("a", "/Users/me/corpus")];
    expect(findInstanceForCwd("/Users/me/corpus", insts)?.name).toBe("a");
  });

  it("matches when CWD is a descendant of the watch_dir", () => {
    const insts = [instance("a", "/Users/me/corpus")];
    expect(findInstanceForCwd("/Users/me/corpus/iarpa/sources", insts)?.name).toBe(
      "a",
    );
  });

  it("does not match prefix-but-not-parent (sibling with shared prefix)", () => {
    // /a/corpus-foo should NOT be considered "inside" /a/corpus.
    const insts = [instance("a", "/Users/me/corpus")];
    expect(findInstanceForCwd("/Users/me/corpus-other", insts)).toBeNull();
  });

  it("picks the deepest match when watch roots are nested", () => {
    const insts = [
      instance("outer", "/Users/me/work"),
      instance("inner", "/Users/me/work/corpus"),
    ];
    expect(
      findInstanceForCwd("/Users/me/work/corpus/iarpa", insts)?.name,
    ).toBe("inner");
  });

  it("ignores instances missing watch_dir (older registry entries)", () => {
    const insts = [
      instance("legacy", undefined),
      instance("modern", "/Users/me/corpus"),
    ];
    expect(findInstanceForCwd("/Users/me/corpus", insts)?.name).toBe("modern");
  });
});

describe("relativeToWatchDir", () => {
  it("returns empty string when CWD equals the watch_dir", () => {
    const inst = instance("a", "/Users/me/corpus");
    expect(relativeToWatchDir("/Users/me/corpus", inst)).toBe("");
  });

  it("returns the relative subpath when CWD is inside the watch_dir", () => {
    const inst = instance("a", "/Users/me/corpus");
    expect(relativeToWatchDir("/Users/me/corpus/iarpa/sources", inst)).toBe(
      "iarpa/sources",
    );
  });

  it("returns null when the instance has no watch_dir", () => {
    const inst = instance("legacy", undefined);
    expect(relativeToWatchDir("/anywhere", inst)).toBeNull();
  });

  it("returns null when CWD escapes the watch_dir", () => {
    const inst = instance("a", "/Users/me/corpus");
    expect(relativeToWatchDir("/Users/me/other", inst)).toBeNull();
  });
});

describe("resolveTarget (no-filesystem branches)", () => {
  it("--api-url wins over everything else", () => {
    const result = resolveTarget({
      apiUrl: "http://example:9999",
      name: "default",
      env: { ARKEON_WIKI_URL: "http://from-env" },
    });
    expect(result.source).toBe("api_url_flag");
    expect(result.api_url).toBe("http://example:9999");
  });

  it("ARKEON_WIKI_URL env beats --name and CWD walk", () => {
    const result = resolveTarget({
      env: { ARKEON_WIKI_URL: "http://from-env" },
      cwd: "/tmp/nowhere",
    });
    expect(result.source).toBe("env");
    expect(result.api_url).toBe("http://from-env");
  });

  it("ARKEON_WIKI_IN_CONTAINER=1 defaults to http://127.0.0.1:${PORT} when nothing else matches", () => {
    // The Dockerfile sets ARKEON_WIKI_IN_CONTAINER=1 + PORT=8062 so the
    // in-container CLI can fall back to the daemon's known loopback
    // when CWD is `/` and the registry lookup misses.
    const result = resolveTarget({
      env: { ARKEON_WIKI_IN_CONTAINER: "1", PORT: "9000" },
      cwd: "/",
    });
    expect(result.source).toBe("in_container_default");
    expect(result.api_url).toBe("http://127.0.0.1:9000");
  });

  it("ARKEON_WIKI_IN_CONTAINER=1 honors PORT default when unset", () => {
    const result = resolveTarget({
      env: { ARKEON_WIKI_IN_CONTAINER: "1" },
      cwd: "/",
    });
    expect(result.source).toBe("in_container_default");
    expect(result.api_url).toBe("http://127.0.0.1:8062");
  });

  it("ARKEON_WIKI_URL still wins over in-container default", () => {
    const result = resolveTarget({
      env: {
        ARKEON_WIKI_IN_CONTAINER: "1",
        ARKEON_WIKI_URL: "http://elsewhere:1234",
      },
      cwd: "/",
    });
    expect(result.source).toBe("env");
    expect(result.api_url).toBe("http://elsewhere:1234");
  });
});
