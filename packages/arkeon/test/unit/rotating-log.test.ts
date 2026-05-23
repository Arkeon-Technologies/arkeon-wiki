// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RotatingLog } from "../../src/cli/lib/rotating-log.js";

describe("RotatingLog", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arkeon-rotating-log-"));
    path = join(dir, "arkeon.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends within the size cap without rotating", () => {
    const log = new RotatingLog({ path, maxBytes: 1024, maxFiles: 3 });
    log.write("hello\n");
    log.write("world\n");
    log.close();

    expect(readFileSync(path, "utf-8")).toBe("hello\nworld\n");
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("rotates when a write would push past maxBytes", () => {
    const log = new RotatingLog({ path, maxBytes: 20, maxFiles: 3 });
    log.write("a".repeat(15)); // size = 15
    log.write("b".repeat(10)); // 15 + 10 > 20 → rotate, then write
    log.close();

    expect(statSync(`${path}.1`).size).toBe(15);
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("a".repeat(15));
    expect(readFileSync(path, "utf-8")).toBe("b".repeat(10));
  });

  it("shifts older backups up and drops the oldest beyond maxFiles", () => {
    const log = new RotatingLog({ path, maxBytes: 10, maxFiles: 2 });
    // Each 10-byte write fills the current file; the next write forces
    // rotation BEFORE writing.
    log.write("1".repeat(10)); // → arkeon.log (10 bytes, exactly maxBytes)
    log.write("2".repeat(10)); // rotate: .log → .log.1; new .log = "2..."
    log.write("3".repeat(10)); // rotate: .1 → .2, .log → .1; new .log = "3..."
    log.write("4".repeat(10)); // rotate: .2 dropped, .1 → .2, .log → .1; .log = "4..."
    log.close();

    expect(readFileSync(path, "utf-8")).toBe("4".repeat(10));
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("3".repeat(10));
    expect(readFileSync(`${path}.2`, "utf-8")).toBe("2".repeat(10));
    // maxFiles=2 means .3 must never exist.
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it("bounds total disk usage under a runaway-write workload", () => {
    const maxBytes = 1024;
    const maxFiles = 3;
    const log = new RotatingLog({ path, maxBytes, maxFiles });

    // Simulate the runaway: 10,000 lines of 100 bytes each = 1 MB of
    // writes. With rotation this must stay under (maxFiles+1)*maxBytes.
    const line = "x".repeat(99) + "\n";
    for (let i = 0; i < 10_000; i++) {
      log.write(line);
    }
    log.close();

    let total = statSync(path).size;
    for (let i = 1; i <= maxFiles; i++) {
      const p = `${path}.${i}`;
      if (existsSync(p)) total += statSync(p).size;
    }
    expect(total).toBeLessThanOrEqual((maxFiles + 1) * maxBytes);
  });

  it("treats maxFiles=0 as truncate-on-rotate", () => {
    const log = new RotatingLog({ path, maxBytes: 10, maxFiles: 0 });
    log.write("1".repeat(10));
    log.write("2".repeat(10));
    log.close();

    expect(readFileSync(path, "utf-8")).toBe("2".repeat(10));
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("appends to a pre-existing file rather than overwriting it", () => {
    // Simulates the daemon restarting and re-opening an existing log.
    const seed = new RotatingLog({ path, maxBytes: 1024, maxFiles: 3 });
    seed.write("first run\n");
    seed.close();

    const next = new RotatingLog({ path, maxBytes: 1024, maxFiles: 3 });
    next.write("second run\n");
    next.close();

    expect(readFileSync(path, "utf-8")).toBe("first run\nsecond run\n");
  });
});
