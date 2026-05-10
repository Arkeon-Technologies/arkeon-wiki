// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Copies src/server/agents/templates/*.yaml → dist/agent-templates/*.yaml
 * at arkeon build time.
 *
 * Runs after `tsup` (see the `build` script in package.json) so tsup's
 * `clean: true` doesn't wipe the output. At runtime, the bundled
 * templates loader probes for an `agent-templates/` sibling directory
 * via the __dirname of the bundled file, which lands here.
 *
 * Mirrors copy-schema.ts. Intentionally dumb — if you find yourself
 * adding filtering or transformation, push that into the source tree.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const source = join(pkgRoot, "src", "server", "agents", "templates");
const target = join(pkgRoot, "dist", "agent-templates");

if (!existsSync(source)) {
  console.error(
    `[copy-agent-templates] source not found at ${source}. ` +
      `Is the build running from inside the arkeon package?`,
  );
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
for (const entry of readdirSync(source)) {
  if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
    cpSync(join(source, entry), join(target, entry));
    copied += 1;
  }
}

console.log(
  `[copy-agent-templates] copied ${copied} YAML file(s) from ${source} → ${target}`,
);
