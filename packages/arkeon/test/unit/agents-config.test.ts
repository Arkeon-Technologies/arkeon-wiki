// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        ingestor: {
          tools: ["list_wikis", "search"],
          max_steps: 5,
          instructions: "be terse",
        },
      },
    });
    expect(parsed.roles?.ingestor?.max_steps).toBe(5);
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

  it("accepts a multi-phase role", () => {
    const parsed = AGENT_CONFIG_SCHEMA.parse({
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        ingestor: {
          phases: [
            { name: "gather", prompt: "phase 1 instructions", model: "gpt-5-mini" },
            { name: "write", prompt: "phase 2 instructions", model: "gpt-5" },
          ],
        },
      },
    });
    expect(parsed.roles?.ingestor?.phases).toHaveLength(2);
    expect(parsed.roles?.ingestor?.phases?.[0]?.name).toBe("gather");
  });

  it("rejects a phase with no prompt", () => {
    expect(() =>
      AGENT_CONFIG_SCHEMA.parse({
        roles: {
          ingestor: { phases: [{ name: "no-prompt" } as unknown as { prompt: string }] },
        },
      }),
    ).toThrow();
  });

  it("accepts per-phase tool whitelist", () => {
    const parsed = AGENT_CONFIG_SCHEMA.parse({
      roles: {
        ingestor: {
          phases: [
            { prompt: "p1", tools: ["read_file", "search"] },
            { prompt: "p2", tools: ["read_file", "edit_file"] },
          ],
        },
      },
    });
    expect(parsed.roles?.ingestor?.phases?.[0]?.tools).toEqual(["read_file", "search"]);
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
      roles: { ingestor: { instructions: "from-a", max_steps: 5 } },
    };
    const b: AgentConfig = { roles: { ingestor: { max_steps: 10 } } };
    const merged = mergeConfigs(a, b);
    // b's ingestor entry wins entirely; instructions from a is dropped
    expect(merged.roles?.ingestor).toEqual({ max_steps: 10 });
  });

  it("preserves roles only present in one side", () => {
    const a: AgentConfig = { roles: { ingestor: { max_steps: 5 } } };
    const b: AgentConfig = { roles: { editor: { max_steps: 20 } } };
    const merged = mergeConfigs(a, b);
    expect(merged.roles?.ingestor?.max_steps).toBe(5);
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

  it("honors ARKEON_WIKI_HOME for the user-global agents.yaml path", () => {
    // Regression for the case the smoke test surfaced: a module-level
    // constant captured homedir() at import, so isolated installs that
    // override ARKEON_WIKI_HOME silently fell back to the real
    // ~/.arkeon-wiki/agents.yaml. Now path resolution happens at call
    // time and ARKEON_WIKI_HOME relocates it.
    const fakeHome = join(dir, "isolated-home");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(
      join(fakeHome, "agents.yaml"),
      "defaults:\n  provider: openai\n  model: from-arkeon-home\n",
    );

    const prev = process.env.ARKEON_WIKI_HOME;
    try {
      process.env.ARKEON_WIKI_HOME = fakeHome;
      // No userGlobalPath override — exercise the code path that
      // computes the path from env.
      const config = loadAgentConfig({ spaceDir: dir });
      expect(config.defaults?.model).toBe("from-arkeon-home");
    } finally {
      if (prev === undefined) delete process.env.ARKEON_WIKI_HOME;
      else process.env.ARKEON_WIKI_HOME = prev;
    }
  });

  it("falls back to ~/.arkeon-wiki/agents.yaml when ARKEON_WIKI_HOME is unset", () => {
    // The fallback shouldn't be tested by writing to the user's real
    // home. Just assert that an unset ARKEON_WIKI_HOME doesn't crash
    // and returns an empty config when ~/.arkeon-wiki/agents.yaml
    // happens not to exist on this machine. If it DOES exist, we
    // skip — we're not validating its contents, only the resolution.
    const prev = process.env.ARKEON_WIKI_HOME;
    try {
      delete process.env.ARKEON_WIKI_HOME;
      // Should not throw; behaviour beyond that depends on the host.
      expect(() => loadAgentConfig({ spaceDir: dir })).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.ARKEON_WIKI_HOME = prev;
    }
  });
});

// ── buildAgentRole ───────────────────────────────────────────────

describe("buildAgentRole — built-in ingestor", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("builds a working AgentRole from just defaults", () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });

    expect(role.name).toBe("ingestor");
    expect(role.maxSteps).toBe(BUILTIN_ROLES.ingestor.max_steps);
    expect(role.tools).toEqual(BUILTIN_ROLES.ingestor.tools);
    expect(role.model).toEqual({
      provider: "openai",
      id: "gpt-5-mini",
      apiKey: "sk-test",
    });
  });

  it("lets a role override the model and provider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      const role = buildAgentRole("ingestor", {
        defaults: { provider: "openai", model: "gpt-5-mini" },
        roles: {
          ingestor: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      });
      expect(role.model.provider).toBe("anthropic");
      expect(role.model.id).toBe("claude-sonnet-4-6");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("layers space-level + role-level instructions onto built-in system", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: {
        provider: "openai",
        model: "gpt-5-mini",
        instructions: "Space-wide focus: climate science.",
      },
      roles: {
        ingestor: { instructions: "Skip generic terms." },
      },
    });

    const { system } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "x.md",
      triggerEntityId: "ent1",
    });

    expect(system).toContain("ingestor");                    // built-in stays
    expect(system).toContain("Space-wide focus: climate");   // defaults layer
    expect(system).toContain("Skip generic terms.");         // role layer
    expect(system).toContain("--- Operator instructions ---");
  });

  it("fills {{trigger_path}} / {{trigger_entity_id}} into the phase prompt", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "sources/foo.md",
      triggerEntityId: "01ENT",
    });
    // The first phase's prompt is the entry-point user message; it
    // must surface the trigger path and entity id (built-in's gather
    // phase puts both at the top so the model can read_file the
    // source).
    const firstPrompt = phases[0]?.prompt ?? "";
    expect(firstPrompt).toContain("sources/foo.md");
    expect(firstPrompt).toContain("01ENT");
  });

  it("throws when the required env var for an api key is missing", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() =>
      buildAgentRole("ingestor", {
        defaults: { provider: "openai", model: "gpt-5-mini" },
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("respects a custom api_key_env name", () => {
    process.env.MY_CUSTOM_KEY = "sk-custom";
    try {
      const role = buildAgentRole("ingestor", {
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
    const role = buildAgentRole("ingestor", {
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
      buildAgentRole("ingestor", {
        defaults: { provider: "openai-compatible", model: "x" },
      }),
    ).toThrow(/base_url/);
  });

  it("built-in ingestor resolves to two phases (gather + write)", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "src/x.txt",
      triggerEntityId: "01ENT",
    });
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe("gather");
    expect(phases[1].name).toBe("write");
    // Gather can't edit; write can.
    expect(phases[0].tools).not.toContain("edit_file");
    expect(phases[1].tools).toContain("edit_file");
    // Trigger path is templated into the gather prompt only — phase 2
    // doesn't repeat it (the conversation history carries it).
    expect(phases[0].prompt).toContain("src/x.txt");
    expect(phases[1].prompt).not.toContain("src/x.txt");
  });

  it("per-phase model override resolves to phase.model", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        ingestor: {
          phases: [
            { name: "gather", prompt: "g", model: "gpt-5-mini" },
            { name: "write", prompt: "w", model: "gpt-5" },
          ],
        },
      },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
    });
    expect(phases[0].model.id).toBe("gpt-5-mini");
    expect(phases[1].model.id).toBe("gpt-5");
    // Same provider — cross-provider out of scope.
    expect(phases[0].model.provider).toBe("openai");
    expect(phases[1].model.provider).toBe("openai");
  });

  it("phase_models shorthand swaps per-phase model without restating prompts", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        ingestor: {
          phase_models: { gather: "gpt-5.4-mini", write: "gpt-5.4" },
        },
      },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "src/x.txt",
    });
    // Two builtin phases, prompts unchanged from the builtin, models swapped.
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe("gather");
    expect(phases[1].name).toBe("write");
    expect(phases[0].model.id).toBe("gpt-5.4-mini");
    expect(phases[1].model.id).toBe("gpt-5.4");
    // Prompts still come from the builtin (we didn't restate them).
    expect(phases[0].prompt).toContain("src/x.txt");
    expect(phases[1].tools).toContain("edit_file");
  });

  it("explicit phase.model beats phase_models lookup", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        ingestor: {
          phase_models: { gather: "from-shorthand", write: "from-shorthand" },
          phases: [
            { name: "gather", prompt: "g", model: "from-explicit" },
            { name: "write", prompt: "w" },
          ],
        },
      },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
    });
    // Explicit phase.model wins; the phase without one falls through to phase_models.
    expect(phases[0].model.id).toBe("from-explicit");
    expect(phases[1].model.id).toBe("from-shorthand");
  });

  it("phase_models with an unknown phase name is ignored but warned about", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const role = buildAgentRole("ingestor", {
        defaults: { provider: "openai", model: "role-default" },
        roles: {
          ingestor: {
            phase_models: { gather: "gpt-5.4-mini", nonexistent: "should-noop" },
          },
        },
      });
      const { phases } = await role.buildPhases({
        space: { id: "s1", name: "n", watch_dir: "/tmp" },
      });
      expect(phases[0].model.id).toBe("gpt-5.4-mini");
      expect(phases[1].model.id).toBe("role-default");

      // The unknown key should produce a single warning naming it,
      // listing valid phase names, and identifying the role.
      const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
      const matching = warnings.filter((w) => w.includes("nonexistent"));
      expect(matching).toHaveLength(1);
      expect(matching[0]).toContain("ingestor");
      expect(matching[0]).toContain("gather");
      expect(matching[0]).toContain("write");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("phase_models with all-known keys does not warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildAgentRole("ingestor", {
        defaults: { provider: "openai", model: "role-default" },
        roles: {
          ingestor: {
            phase_models: { gather: "gpt-5.4-mini", write: "gpt-5.4" },
          },
        },
      });
      const matching = warnSpy.mock.calls
        .map((c) => c.join(" "))
        .filter((w) => w.includes("phase_models"));
      expect(matching).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("phase_models layers: role override beats defaults", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: {
        provider: "openai",
        model: "gpt-5-mini",
        phase_models: { gather: "default-gather", write: "default-write" },
      },
      roles: {
        ingestor: { phase_models: { write: "role-write" } },
      },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
    });
    // gather: defaults supplies it (role didn't override).
    expect(phases[0].model.id).toBe("default-gather");
    // write: role override beats defaults.
    expect(phases[1].model.id).toBe("role-write");
  });

  it("synthesizes a single phase from `user` when `phases` is unset", async () => {
    const role = buildAgentRole("custom-single", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        "custom-single": {
          tools: ["read_file"],
          system: "you are a single-phase agent",
          user: "do thing for {{trigger_path}}",
        },
      },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "x.md",
    });
    expect(phases).toHaveLength(1);
    expect(phases[0].prompt).toContain("x.md");
  });

  it("phases override beats user — when both are set, phases wins", async () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
      roles: {
        ingestor: {
          // The built-in already has phases. Re-setting `user` here
          // shouldn't introduce a third phase or replace the built-in
          // ones — phases (from the built-in) wins.
          user: "this should be ignored",
        },
      },
    });
    const { phases } = await role.buildPhases({
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
    });
    expect(phases).toHaveLength(2);
    for (const p of phases) {
      expect(p.prompt).not.toContain("this should be ignored");
    }
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
    expect(roles).toContain("ingestor");
    expect(roles).toContain("my-thing");
  });

  it("does not duplicate when a YAML override targets a built-in", () => {
    const roles = listAvailableRoles({
      roles: { ingestor: { max_steps: 99 } },
    });
    const contribCount = roles.filter((r) => r === "ingestor").length;
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
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const input: AgentInput = {
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerPath: "src/a.md",
    };
    expect(role.idempotencyKey(input).key).toBe("src/a.md");
  });

  it("falls back to triggerEntityId", () => {
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    const input: AgentInput = {
      space: { id: "s1", name: "n", watch_dir: "/tmp" },
      triggerEntityId: "01ENT",
    };
    expect(role.idempotencyKey(input).key).toBe("01ENT");
  });

  it("hashes meta + trigger info into the idempotency hash", () => {
    const role = buildAgentRole("ingestor", {
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
    const role = buildAgentRole("ingestor", {
      defaults: { provider: "openai", model: "gpt-5-mini" },
    });
    expect(
      role.concurrencyKey({
        space: { id: "s1", name: "n", watch_dir: "/tmp" },
        triggerEntityId: "01ENT",
      }),
    ).toBe("ingestor::s1::01ENT");
  });
});
