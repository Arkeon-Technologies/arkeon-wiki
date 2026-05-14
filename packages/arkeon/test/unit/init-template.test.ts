// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENTS_YAML_TEMPLATES,
  DEFAULT_AGENTS_TEMPLATE,
  writeAgentsYamlTemplate,
} from "../../src/cli/commands/repo/config.js";

describe("writeAgentsYamlTemplate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arkeon-init-tpl-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the default template when none is named", () => {
    const result = writeAgentsYamlTemplate({ targetDir: dir });
    expect(result.created).toBe(true);
    expect(result.template).toBe(DEFAULT_AGENTS_TEMPLATE);
    expect(result.path).toBe(join(dir, ".arkeon", "agents.yaml"));
    const written = readFileSync(result.path, "utf-8");
    expect(written).toBe(AGENTS_YAML_TEMPLATES[DEFAULT_AGENTS_TEMPLATE]);
  });

  it("creates the .arkeon directory if missing", () => {
    expect(existsSync(join(dir, ".arkeon"))).toBe(false);
    writeAgentsYamlTemplate({ targetDir: dir });
    expect(existsSync(join(dir, ".arkeon"))).toBe(true);
  });

  it("is idempotent — leaves an existing file untouched", () => {
    const path = join(dir, ".arkeon", "agents.yaml");
    writeAgentsYamlTemplate({ targetDir: dir });
    writeFileSync(path, "# my edits\ndefaults: {}\n");

    const result = writeAgentsYamlTemplate({ targetDir: dir });
    expect(result.created).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("# my edits\ndefaults: {}\n");
  });

  it("overwrites when force is set", () => {
    const path = join(dir, ".arkeon", "agents.yaml");
    writeAgentsYamlTemplate({ targetDir: dir });
    writeFileSync(path, "# my edits\n");

    const result = writeAgentsYamlTemplate({ targetDir: dir, force: true });
    expect(result.created).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(
      AGENTS_YAML_TEMPLATES[DEFAULT_AGENTS_TEMPLATE],
    );
  });

  it("throws on an unknown template name with the available list", () => {
    expect(() =>
      writeAgentsYamlTemplate({ targetDir: dir, template: "nope" }),
    ).toThrow(/Unknown agents\.yaml template 'nope'.*Available: wiki/);
  });
});
