// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_CONFIG_SCHEMA,
  loadAgentConfig,
  mergeConfigs,
  type AgentConfig,
} from "../../src/server/agents/config.js";
import { BUILTIN_ROLES } from "../../src/server/agents/builtins.js";
import {
  buildAgentRole,
  fillTemplate,
  listAvailableRoles,
} from "../../src/server/agents/role-builder.js";
import type { AgentInput } from "../../src/server/agents/runtime.js";

// ── Schema ───────────────────────────────────────────────────────

describe("AGENT_CONFIG_SCHEMA", () => {
  it("accepts an empty config", () => {
    expect(AGENT_CONFIG_SCHEMA.parse({})).toEqual({});
  });

  it("accepts defaults only", () => {
    const parsed = AGENT_CONFIG_SCHEMA.parse({
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    expect(parsed.defaults?.provider).toBe("openai");
  });

  it("accepts a full configured role", () => {
    const parsed = AGENT_CONFIG_SCHEMA.parse({
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        contributor: {
          tools: ["list_wikis", "contribute"],
          max_steps: 5,
          instructions: "be terse",
        },
      },
    });
    expect(parsed.roles?.contributor?.max_steps).toBe(5);
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      AGENT_CONFIG_SCHEMA.parse({ defaults: { provider: "weirdo" } }),
    ).toThrow();
  });

  it("rejects max_steps <= 0", () => {
    expect(() =>
      AGENT_CONFIG_SCHEMA.parse({ defaults: { max_steps: 0 } }),
    ).toThrow();
  });
});

// ── mergeConfigs ─────────────────────────────────────────────────

describe("mergeConfigs", () => {
  it("merges defaults field-by-field, b wins", () => {
    const a: AgentConfig = { defaults: { provider: "openai", model: "a" } };
    const b: AgentConfig = { defaults: { model: "b" } };
    const merged = mergeConfigs(a, b);
    expect(merged.defaults).toEqual({ provider: "openai", model: "b" });
  });

  it("replaces roles wholesale (not field-merged)", () => {
    const a: AgentConfig = {
      roles: { contributor: { instructions: "from-a", max_steps: 5 } },
    };
    const b: AgentConfig = { roles: { contributor: { max_steps: 10 } } };
    const merged = mergeConfigs(a, b);
    // b's contributor entry wins entirely; instructions from a is dropped
    expect(merged.roles?.contributor).toEqual({ max_steps: 10 });
  });

  it("preserves roles only present in one side", () => {
    const a: AgentConfig = { roles: { contributor: { max_steps: 5 } } };
    const b: AgentConfig = { roles: { editor: { max_steps: 20 } } };
    const merged = mergeConfigs(a, b);
    expect(merged.roles?.contributor?.max_steps).toBe(5);
    expect(merged.roles?.editor?.max_steps).toBe(20);
  });
});

// ── loadAgentConfig ──────────────────────────────────────────────

describe("loadAgentConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agents-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty config when no files exist", () => {
    expect(
      loadAgentConfig({ spaceDir: dir, userGlobalPath: join(dir, "nope.yaml") }),
    ).toEqual({ defaults: {}, roles: {} });
  });

  it("loads a repo-local agents.yaml", () => {
    mkdirSync(join(dir, ".arkeon"), { recursive: true });
    writeFileSync(
      join(dir, ".arkeon", "agents.yaml"),
      "defaults:\n  provider: openai\n  model: gpt-5-mini\n",
    );
    const config = loadAgentConfig({
      spaceDir: dir,
      userGlobalPath: join(dir, "nonexistent-global.yaml"),
    });
    expect(config.defaults?.provider).toBe("openai");
    expect(config.defaults?.model).toBe("gpt-5-mini");
  });

  it("repo-local overrides user-global on shared fields", () => {
    const globalPath = join(dir, "global.yaml");
    writeFileSync(
      globalPath,
      "defaults:\n  provider: anthropic\n  model: claude-sonnet-4-6\n",
    );
    mkdirSync(join(dir, ".arkeon"), { recursive: true });
    writeFileSync(
      join(dir, ".arkeon", "agents.yaml"),
      "defaults:\n  model: gpt-5-mini\n",
    );

    const config = loadAgentConfig({ spaceDir: dir, userGlobalPath: globalPath });
    expect(config.defaults?.provider).toBe("anthropic");  // from global
    expect(config.defaults?.model).toBe("gpt-5-mini");    // overridden by repo
  });

  it("throws a clear error on invalid YAML", () => {
    mkdirSync(join(dir, ".arkeon"), { recursive: true });
    writeFileSync(
      join(dir, ".arkeon", "agents.yaml"),
      "defaults: {[\n  not yaml at all\n",
    );
    expect(() =>
      loadAgentConfig({
        spaceDir: dir,
        userGlobalPath: join(dir, "nope.yaml"),
      }),
    ).toThrow(/not valid YAML/);
  });
});

// ── buildAgentRole ───────────────────────────────────────────────

describe("buildAgentRole — built-in contributor", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("builds a working AgentRole from just defaults", () => {
    const role = buildAgentRole("contributor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });

    expect(role.name).toBe("contributor");
    expect(role.maxSteps).toBe(BUILTIN_ROLES.contributor.max_steps);
    expect(role.tools).toEqual(BUILTIN_ROLES.contributor.tools);
    expect(role.model).toEqual({
      provider: "openai",
      id: "gpt-5-mini",
      apiKey: "sk-test",
    });
  });

  it("lets a role override the model and provider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      const role = buildAgentRole("contributor", {
        defaults: { provider: "openai", model: "gpt-5-mini" },
        roles: {
          contributor: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      });
      expect(role.model.provider).toBe("anthropic");
      expect(role.model.id).toBe("claude-sonnet-4-6");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("layers space-level + role-level instructions onto built-in system", async () => {
    const role = buildAgentRole("contributor", {
      defaults: {
        provider: "openai",
        model: "gpt-5-mini",
        instructions: "Space-wide focus: climate science.",
      },
      roles: {
        contributor: { instructions: "Skip generic terms." },
      },
    });

    const { system } = await role.buildPrompt({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "x.md",
      triggerEntityId: "ent1",
    });

    expect(system).toContain("contributor agent");           // built-in stays
    expect(system).toContain("Space-wide focus: climate");   // defaults layer
    expect(system).toContain("Skip generic terms.");         // role layer
    expect(system).toContain("--- Operator instructions ---");
  });

  it("fills {{trigger_path}} / {{trigger_entity_id}} into the user template", async () => {
    const role = buildAgentRole("contributor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const { prompt } = await role.buildPrompt({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "sources/foo.md",
      triggerEntityId: "01ENT",
    });
    expect(prompt).toContain("sources/foo.md");
    expect(prompt).toContain("01ENT");
  });

  it("throws when the required env var for an api key is missing", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() =>
      buildAgentRole("contributor", {
        defaults: { provider: "openai", model: "gpt-5-mini" },
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("respects a custom api_key_env name", () => {
    process.env.MY_CUSTOM_KEY = "sk-custom";
    try {
      const role = buildAgentRole("contributor", {
        defaults: {
          provider: "openai",
          model: "gpt-5-mini",
          api_key_env: "MY_CUSTOM_KEY",
        },
      });
      expect(role.model.apiKey).toBe("sk-custom");
    } finally {
      delete process.env.MY_CUSTOM_KEY;
    }
  });

  it("openai-compatible can run without an api key (local servers)", () => {
    delete process.env.OPENAI_API_KEY;
    const role = buildAgentRole("contributor", {
      defaults: {
        provider: "openai-compatible",
        model: "llama3.1:70b",
        base_url: "http://localhost:11434/v1",
      },
    });
    expect(role.model.provider).toBe("openai-compatible");
  });

  it("openai-compatible requires base_url", () => {
    expect(() =>
      buildAgentRole("contributor", {
        defaults: { provider: "openai-compatible", model: "x" },
      }),
    ).toThrow(/base_url/);
  });
});

describe("buildAgentRole — user-defined role", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("builds a custom role with explicit system + tools", () => {
    const role = buildAgentRole("link-checker", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        "link-checker": {
          system: "You find broken links.",
          tools: ["list_wikis", "read_file"],
          max_steps: 30,
        },
      },
    });

    expect(role.name).toBe("link-checker");
    expect(role.tools).toEqual(["list_wikis", "read_file"]);
    expect(role.maxSteps).toBe(30);
  });

  it("rejects a custom role without a system prompt", () => {
    expect(() =>
      buildAgentRole("custom-no-prompt", {
        defaults: { provider: "openai", model: "gpt-5-mini" },
        roles: { "custom-no-prompt": { tools: ["read_file"] } },
      }),
    ).toThrow(/system prompt/);
  });

  it("rejects a custom role without tools", () => {
    expect(() =>
      buildAgentRole("custom-no-tools", {
        defaults: { provider: "openai", model: "gpt-5-mini" },
        roles: { "custom-no-tools": { system: "you are X" } },
      }),
    ).toThrow(/no tools/);
  });
});

// ── fillTemplate ─────────────────────────────────────────────────

describe("fillTemplate", () => {
  it("substitutes {{var}} placeholders", () => {
    expect(fillTemplate("hi {{name}}, path is {{p}}", { name: "Ada", p: "x.md" })).toBe(
      "hi Ada, path is x.md",
    );
  });

  it("treats unknown vars as empty string (no throw)", () => {
    expect(fillTemplate("hi {{missing}} done", {})).toBe("hi  done");
  });

  it("leaves non-matching braces alone", () => {
    expect(fillTemplate("a {b} c", { b: "1" })).toBe("a {b} c");
  });
});

// ── listAvailableRoles ───────────────────────────────────────────

describe("listAvailableRoles", () => {
  it("includes all built-ins", () => {
    expect(listAvailableRoles({})).toEqual(
      Object.keys(BUILTIN_ROLES).sort(),
    );
  });

  it("includes user-defined roles alongside built-ins", () => {
    const roles = listAvailableRoles({
      roles: { "my-thing": { system: "x", tools: ["read_file"] } },
    });
    expect(roles).toContain("contributor");
    expect(roles).toContain("editor");
    expect(roles).toContain("my-thing");
  });

  it("does not duplicate when a YAML override targets a built-in", () => {
    const roles = listAvailableRoles({
      roles: { contributor: { max_steps: 99 } },
    });
    const contribCount = roles.filter((r) => r === "contributor").length;
    expect(contribCount).toBe(1);
  });
});

// ── default keying ───────────────────────────────────────────────

describe("default idempotency / concurrency keys", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("uses triggerPath as the idempotency key when present", () => {
    const role = buildAgentRole("contributor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const input: AgentInput = {
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "src/a.md",
    };
    expect(role.idempotencyKey(input).key).toBe("src/a.md");
  });

  it("falls back to triggerEntityId", () => {
    const role = buildAgentRole("contributor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const input: AgentInput = {
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerEntityId: "01ENT",
    };
    expect(role.idempotencyKey(input).key).toBe("01ENT");
  });

  it("hashes meta + trigger info into the idempotency hash", () => {
    const role = buildAgentRole("contributor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const a = role.idempotencyKey({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "x.md",
      meta: { hash: "v1" },
    });
    const b = role.idempotencyKey({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "x.md",
      meta: { hash: "v2" },
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it("scopes concurrency to (role, space, triggerEntityId)", () => {
    const role = buildAgentRole("contributor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    expect(
      role.concurrencyKey({
        space: { id: "s1", name: "n", watch_dir: "/tmp" },
        triggerEntityId: "01ENT",
      }),
    ).toBe("contributor::s1::01ENT");
  });
});
