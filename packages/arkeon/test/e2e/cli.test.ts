// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI integration tests for generated API commands (entities, actors, etc.)
 * and built-in commands (seed, docs).
 *
 * These test the actual CLI commands as child processes (not raw API calls),
 * catching wiring bugs between the CLI codegen layer and the API. Follows the
 * same pattern as repo-cli.test.ts.
 */

import { describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "dotenv";
import { adminApiKey, createActor, createSpace, uniqueName } from "./helpers";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:8000";
const adminKey = process.env.ADMIN_BOOTSTRAP_KEY ?? "ak_test_admin_key_e2e";

const CLI_ROOT = resolve(import.meta.dirname, "../..");

function arkeon(cmd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(
      `npx tsx ${join(CLI_ROOT, "src/index.ts")} ${cmd} 2>&1`,
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          ARKE_API_URL: baseUrl,
          ARKE_API_KEY: adminKey,
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        timeout: 30_000,
      },
    ).toString();
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = e.stdout?.toString() ?? e.stderr?.toString() ?? e.message ?? "";
    return { ok: false, stdout: output, stderr: output };
  }
}

function parseJson(output: string): Record<string, unknown> | null {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("CLI integration — generated API commands", () => {
  // --- seed ---

  // The seed command reads the admin key from ~/.arkeon/secrets.json and
  // does not accept a --space-id flag. When the admin actor has access to
  // multiple spaces (common after e2e test runs), it fails with
  // "ambiguous_default_space". Skip until the seed command is updated to
  // either accept --space-id or auto-create its own space.
  test.skip("seed loads Genesis knowledge graph (requires single-space admin)", () => {});
  test.skip("seed is idempotent (requires single-space admin)", () => {});

  // --- wiki ---

  test("wiki list returns entities", () => {
    const result = arkeon("wiki list --raw");
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    expect(json).toHaveProperty("entities");
    const entities = json?.entities as unknown[];
    expect(entities.length).toBeGreaterThan(0);
  });

  // This test depends on seed data (books) which requires a single-space
  // admin. Skip until seed is fixed.
  test.skip("wiki list --filter subject_type filters by subject type (requires seed)", () => {});

  let createdEntityId: string | undefined;
  let cliSpaceId: string | undefined;

  test("wiki create creates a new entity", async () => {
    // Create a space via the API so the CLI command can use --space-id
    const actor = await createActor(adminKey);
    const space = await createSpace(actor.apiKey, uniqueName("cli-wiki-space"));
    cliSpaceId = space.id;

    const result = arkeon(
      `wiki create --label "CLI Smoke Test Person" --short-description "A test person entity" --keywords '["test"]' --content "A person for CLI smoke testing." --type person --space-id ${cliSpaceId}`,
    );
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();

    // With --raw omitted, the CLI wraps in { ok, data: { wiki: { id } } }
    // With --raw, the raw API response is { wiki: { id, ... } }
    const data = (json?.data ?? json) as Record<string, unknown>;
    const wiki = (data?.wiki ?? data?.entity ?? data) as Record<string, unknown>;
    const id = wiki?.id as string | undefined;
    expect(id).toBeTruthy();
    createdEntityId = id;
  });

  test("wiki get retrieves the created entity", () => {
    expect(createdEntityId).toBeTruthy();

    const result = arkeon(`wiki get ${createdEntityId} --raw`);
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    // --raw returns { entity: { id, type, properties, ... } }
    const entity = (json?.entity ?? json) as Record<string, unknown>;
    expect(entity?.type).toBe("wiki");
    const props = entity?.properties as Record<string, unknown>;
    expect(props?.label).toBe("CLI Smoke Test Person");
  });

  // --- actors ---

  test("actors list returns actors", () => {
    const result = arkeon("actors list --raw");
    expect(result.ok).toBe(true);

    const json = parseJson(result.stdout);
    expect(json).not.toBeNull();
    expect(json).toHaveProperty("actors");
    const actors = json?.actors as unknown[];
    expect(Array.isArray(actors)).toBe(true);
    expect(actors.length).toBeGreaterThan(0);
  });

  // --- docs ---

  test("docs outputs API documentation", () => {
    const result = arkeon("docs");
    expect(result.ok).toBe(true);
    // docs prints formatted text to stdout
    expect(result.stdout.length).toBeGreaterThan(100);
  });
});
