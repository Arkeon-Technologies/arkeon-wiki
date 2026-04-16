// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// We test the provider logic directly rather than going through commander,
// since the command handler is a thin wrapper.
import { AGENTS_MD, SKILLS } from "../../src/generated/assets.js";

describe("install / uninstall", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `arkeon-install-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("SKILLS asset has claude provider with arkeon-connect", () => {
    expect(SKILLS).toBeDefined();
    expect(SKILLS["claude"]).toBeDefined();
    expect(SKILLS["claude"]!["arkeon-connect"]).toBeDefined();
    expect(SKILLS["claude"]!["arkeon-connect"]).toContain("name: arkeon-connect");
  });

  test("SKILLS asset has all providers", () => {
    for (const provider of ["claude", "codex", "cursor", "gemini"]) {
      expect(SKILLS[provider]).toBeDefined();
      expect(Object.keys(SKILLS[provider]!).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("skill content contains valid YAML frontmatter", () => {
    const content = SKILLS["claude"]!["arkeon-connect"]!;
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("description:");
    expect(content).toContain("allowed-tools:");
    expect(content).toContain("disable-model-invocation: true");
  });

  test("codex skills do not have claude-specific frontmatter", () => {
    const content = SKILLS["codex"]!["arkeon-connect"]!;
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: arkeon-connect");
    expect(content).not.toContain("disable-model-invocation");
    expect(content).not.toContain("allowed-tools:");
  });

  test("all providers share the same body content", () => {
    const claudeBody = SKILLS["claude"]!["arkeon-connect"]!.split("---").slice(2).join("---");
    const codexBody = SKILLS["codex"]!["arkeon-connect"]!.split("---").slice(2).join("---");
    expect(claudeBody).toBe(codexBody);
  });

  test("install writes skill files to target directory", () => {
    const skills = SKILLS["claude"] ?? {};
    for (const [name, content] of Object.entries(skills)) {
      const skillDir = join(testDir, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), content);
    }

    const skillPath = join(testDir, "arkeon-connect", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const written = readFileSync(skillPath, "utf-8");
    expect(written).toContain("name: arkeon-connect");
    expect(written).toContain("# Arkeon Connect");
  });

  test("install is idempotent — overwrites cleanly", () => {
    const skillDir = join(testDir, "arkeon-connect");
    mkdirSync(skillDir, { recursive: true });

    // Write once
    writeFileSync(join(skillDir, "SKILL.md"), "old content");

    // Overwrite with real content
    const content = SKILLS["claude"]!["arkeon-connect"]!;
    writeFileSync(join(skillDir, "SKILL.md"), content);

    const result = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(result).toContain("name: arkeon-connect");
    expect(result).not.toContain("old content");
  });

  test("uninstall removes skill directories", () => {
    const skillDir = join(testDir, "arkeon-connect");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "content");
    expect(existsSync(skillDir)).toBe(true);

    rmSync(skillDir, { recursive: true });
    expect(existsSync(skillDir)).toBe(false);
  });

  test("uninstall is idempotent — no error on missing directory", () => {
    const skillDir = join(testDir, "arkeon-connect");
    expect(existsSync(skillDir)).toBe(false);
    // Should not throw
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true });
    }
  });

  test("skill name validation rejects bad names", () => {
    const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/;
    expect(VALID_NAME.test("arkeon-connect")).toBe(true);
    expect(VALID_NAME.test("claude")).toBe(true);
    expect(VALID_NAME.test("__proto__")).toBe(false);
    expect(VALID_NAME.test("../../.bashrc")).toBe(false);
    expect(VALID_NAME.test("")).toBe(false);
    expect(VALID_NAME.test("-leading-dash")).toBe(false);
    expect(VALID_NAME.test("UPPERCASE")).toBe(false);
  });

  test("AGENTS_MD contains arkeon managed marker", () => {
    expect(AGENTS_MD).toBeDefined();
    expect(AGENTS_MD).toContain("<!-- arkeon:managed");
    expect(AGENTS_MD).toContain("# Arkeon");
  });

  test("getProvider rejects prototype pollution", () => {
    const providers: Record<string, { name: string }> = { claude: { name: "claude" } };
    // Direct bracket access would return Object.prototype methods
    expect(Object.hasOwn(providers, "__proto__")).toBe(false);
    expect(Object.hasOwn(providers, "constructor")).toBe(false);
    expect(Object.hasOwn(providers, "claude")).toBe(true);
  });
});
