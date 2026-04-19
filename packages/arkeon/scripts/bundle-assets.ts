// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bundles the Genesis seed and composed skills into a single TypeScript module
 * at src/generated/assets.ts.
 *
 * Skills are composed from three sources:
 *   1. Shared body content: assets/skills/body/<skill>.md
 *   2. Provider metadata:   assets/skills/meta.yaml
 *   3. Optional overrides:  assets/skills/overrides/<provider>/<skill>.md
 *
 * For each provider defined in meta.yaml, the bundler composes a complete
 * skill file by combining the provider-specific YAML frontmatter with the
 * shared body and any override content.
 *
 * The AGENTS.md template is bundled under the special key AGENTS_MD.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, "..");

const genesisWikisPath = join(cliRoot, "assets", "seeds", "genesis-wikis.json");
const outputPath = join(cliRoot, "src", "generated", "assets.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`bundle-assets: failed to read ${path}: ${(error as Error).message}`);
  }
}

function readTextOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  const text = readText(path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`bundle-assets: ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Genesis seed
// ---------------------------------------------------------------------------

const genesisWikis = readJson(genesisWikisPath);

// ---------------------------------------------------------------------------
// Skills — compose from meta.yaml + body/ + overrides/
// ---------------------------------------------------------------------------

interface SkillMeta {
  description: string;
  "argument-hint"?: string;
}

interface ProviderConfig {
  format: string;
  dir: string;
  global: boolean;
  frontmatter: {
    common: Record<string, unknown>;
    "per-skill": Record<string, Record<string, unknown>>;
  };
}

interface MetaFile {
  skills: Record<string, SkillMeta>;
  providers: Record<string, ProviderConfig>;
}

const YAML_NEEDS_QUOTING = /^[{[\]>|*&!%#@`'",?:=-]|[:{}\[\],] |: |#/;

function formatYamlValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (YAML_NEEDS_QUOTING.test(s) || s === "" || s === "true" || s === "false" || s === "null") {
    return JSON.stringify(s); // double-quote escaping
  }
  return s;
}

const skillsDir = join(cliRoot, "assets", "skills");
const metaPath = join(skillsDir, "meta.yaml");
const skills: Record<string, Record<string, string>> = {};

if (existsSync(metaPath)) {
  const meta = yaml.load(readText(metaPath)) as MetaFile;
  const skillNames = Object.keys(meta.skills);

  for (const [providerName, providerConfig] of Object.entries(meta.providers)) {
    skills[providerName] = {};

    for (const skillName of skillNames) {
      const bodyPath = join(skillsDir, "body", `${skillName}.md`);
      const body = readTextOptional(bodyPath);
      if (!body) {
        console.warn(`bundle-assets: skipping ${providerName}/${skillName} — no body file`);
        continue;
      }

      // Compose frontmatter: skill metadata + provider common + provider per-skill
      const skillMeta = meta.skills[skillName]!;
      const fm: Record<string, unknown> = { name: skillName };

      fm.description = skillMeta.description;
      if (skillMeta["argument-hint"]) {
        fm["argument-hint"] = skillMeta["argument-hint"];
      }

      // Provider common frontmatter (e.g., disable-model-invocation for Claude)
      const common = providerConfig.frontmatter?.common ?? {};
      for (const [k, v] of Object.entries(common)) {
        fm[k] = v;
      }

      // Provider per-skill frontmatter (e.g., allowed-tools for Claude)
      const perSkill = providerConfig.frontmatter?.["per-skill"]?.[skillName] ?? {};
      for (const [k, v] of Object.entries(perSkill)) {
        fm[k] = v;
      }

      // Build YAML frontmatter string
      const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${formatYamlValue(v)}`);
      const frontmatter = `---\n${fmLines.join("\n")}\n---`;

      // Optional override content
      const overridePath = join(skillsDir, "overrides", providerName, `${skillName}.md`);
      const override = readTextOptional(overridePath);

      // Compose final content
      let content = `${frontmatter}\n\n${body.trim()}`;
      if (override) {
        content += `\n\n${override.trim()}`;
      }
      content += "\n";

      skills[providerName]![skillName] = content;
    }
  }
} else {
  console.warn("bundle-assets: no meta.yaml found — no skills to bundle");
}


// ---------------------------------------------------------------------------
// AGENTS.md template
// ---------------------------------------------------------------------------

const agentsMdPath = join(skillsDir, "agents.md");
const agentsMd = readTextOptional(agentsMdPath) ?? "";

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const banner = `// AUTO-GENERATED by scripts/bundle-assets.ts — do not edit.
// Re-generate with \`npm run bundle-assets -w packages/arkeon\` (also runs as
// part of \`npm run build -w packages/arkeon\`).
//
// Source files:
//   - genesis-wikis.json  <- assets/seeds/
//   - meta.yaml + body/ + overrides/ <- assets/skills/
//   - agents.md  <- assets/skills/agents.md
`;

const skillEntries = Object.entries(skills)
  .map(([provider, providerSkills]) => {
    const entries = Object.entries(providerSkills)
      .map(([name, content]) => `    ${JSON.stringify(name)}: ${JSON.stringify(content)}`)
      .join(",\n");
    return `  ${JSON.stringify(provider)}: {\n${entries}\n  }`;
  })
  .join(",\n");

const body = `${banner}
/**
 * Array of wiki payloads ready to POST to /wiki. Used by \`arkeon seed\`
 * to create the Genesis demonstration wikis.
 */
export const GENESIS_WIKIS: Array<{ label: string; subject_type?: string; keywords: string[]; short_description: string; aliases?: string[]; content: string }> = ${JSON.stringify(genesisWikis)};

/**
 * Bundled skills keyed by provider → skill-name → composed skill content.
 * Used by \`arkeon install <provider>\` to write skills to the target directory.
 */
export const SKILLS: Record<string, Record<string, string>> = {
${skillEntries}
};

/**
 * Universal AGENTS.md template written to project roots by \`arkeon install agents\`.
 */
export const AGENTS_MD: string = ${JSON.stringify(agentsMd)};
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, body);

console.log(`bundle-assets: wrote ${outputPath}`);
console.log(`  genesis-wikis.json: ${(JSON.stringify(genesisWikis) as string).length} bytes (parsed)`);
const skillCount = Object.values(skills).reduce((n, s) => n + Object.keys(s).length, 0);
console.log(`  skills: ${skillCount} across ${Object.keys(skills).length} provider(s)`);
console.log(`  agents.md: ${agentsMd.length} bytes`);
