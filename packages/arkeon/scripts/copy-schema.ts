// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Copies src/schema/*.sql → dist/schema/*.sql at arkeon build time.
 *
 * Runs after `tsup` (see the `build` script in package.json) so tsup's
 * `clean: true` doesn't wipe the output. At runtime, the bundled
 * migrate.ts (now part of dist/index.js) probes for a `schema/`
 * sibling directory via the __dirname of the bundled file, which
 * lands here.
 *
 * Intentionally dumb — mirrors copy-agent-templates.ts. If you find yourself
 * adding filtering or transformation, stop and push that into the
 * source tree instead.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const source = join(pkgRoot, "src", "schema");
const target = join(pkgRoot, "dist", "schema");

if (!existsSync(source)) {
  console.error(
    `[copy-schema] source not found at ${source}. ` +
      `Is the build running from inside the arkeon package?`,
  );
  process.exit(1);
}

// Recreate the target fresh so removed migrations don't linger.
mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
for (const entry of readdirSync(source)) {
  if (entry.endsWith(".sql")) {
    cpSync(join(source, entry), join(target, entry));
    copied += 1;
  }
}

console.log(
  `[copy-schema] copied ${copied} SQL file(s) from ${source} → ${target}`,
);
