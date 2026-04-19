// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process schema migration runner.
 *
 * Replaces the old packages/schema/migrate.js top-level-await script.
 * The CLI's `arkeon start` command imports runMigrations() directly
 * now instead of spawning a child process, which lets the CLI reason
 * about lifecycle errors with normal try/catch.
 *
 * The SQL files live next to this module at build time (src/schema/*.sql
 * in dev, dist/schema/*.sql in the published tarball via
 * scripts/copy-schema.ts). At runtime we probe both locations so the
 * same bundle works in both dev and tarball shapes.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrateOptions {
  /** Superuser connection string — must have permission to run DDL. */
  databaseUrl: string;
  /**
   * Password to assign to the arke_app role. Substituted into
   * 001-foundation.sql via the :'arke_app_password' template token. Defaults
   * to the legacy "arke" password for ad-hoc local dev runs; the CLI
   * passes the value from ~/.arkeon-wiki/secrets.json at start time.
   */
  arkeAppPassword?: string;
}

export async function runMigrations(opts: MigrateOptions): Promise<void> {
  const url = opts.databaseUrl;
  console.log(`Deploying schema to: ${url.replace(/:[^@]*@/, ":***@")}`);
  console.log("");

  const templateVars: Record<string, string> = {
    arke_app_password: opts.arkeAppPassword ?? "arke",
  };

  const schemaDir = await locateSchemaDir();
  const files = (await readdir(schemaDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const sql = postgres(url);
  let failed = false;

  try {
    for (const file of files) {
      const rawContent = await readFile(join(schemaDir, file), "utf-8");
      const content = applyTemplate(rawContent, file, templateVars);
      const statements = splitStatements(content);
      process.stdout.write(`  ${file} ... `);

      let fileOk = true;
      let skipped = false;

      for (const stmt of statements) {
        // Skip comment-only blocks — splitStatements keeps the raw
        // whitespace/comments, so an "empty after stripping -- line
        // comments" check catches the leading banner in each file.
        if (stmt.replace(/--[^\n]*/g, "").trim() === "") continue;

        try {
          await sql.unsafe(stmt);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = (err as { code?: string }).code;
          if (code === "42P07" || msg.includes("already exists")) {
            skipped = true;
          } else if (code === "42703" && msg.includes("does not exist")) {
            // Column was renamed by a later migration — index already covers it.
            skipped = true;
          } else {
            console.log(`ERROR: ${msg}`);
            fileOk = false;
            failed = true;
            break;
          }
        }
      }

      if (fileOk) {
        console.log(skipped ? "OK (exists)" : "OK");
      }
    }
  } finally {
    await sql.end();
  }

  console.log("");
  if (failed) {
    throw new Error("Schema deployment had errors. Review output above.");
  }
  console.log("Schema deployed successfully.");
}

/**
 * Find the directory containing the numbered *.sql files. Two cases:
 *
 *   - dev (tsx): `__dirname` points at packages/arkeon/src/schema.
 *     The SQL files live right next to this file.
 *   - published tarball: the bundled dist/index.js imports this module
 *     inline, so `__dirname` points at packages/arkeon/dist. The SQL
 *     files are copied into dist/schema by scripts/copy-schema.ts at
 *     build time, a sibling of the bundle.
 *
 * We probe both. Whichever exists wins.
 */
async function locateSchemaDir(): Promise<string> {
  const candidates = [
    __dirname, // dev: src/schema
    join(__dirname, "schema"), // tarball: dist/schema relative to dist/index.js
  ];
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate);
      if (entries.some((e) => e.endsWith(".sql"))) return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Could not locate schema SQL files. Tried: ${candidates.join(", ")}`,
  );
}

function quoteSqlLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function applyTemplate(
  content: string,
  file: string,
  vars: Record<string, string>,
): string {
  // Replace :'name' tokens. The set of recognized names is fixed by
  // templateVars — anything else is a typo and should fail loudly
  // rather than send broken SQL to Postgres.
  return content.replace(/:'([a-zA-Z_][a-zA-Z0-9_]*)'/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(
        `${file}: unknown template variable :'${name}'. Known: ${Object.keys(vars).join(", ")}`,
      );
    }
    return quoteSqlLiteral(vars[name]);
  });
}

/**
 * Split a SQL file into individual statements. Handles:
 * - $$ dollar-quoted blocks (functions, cron jobs)
 * - -- line comments (semicolons inside are ignored)
 * - Single-quoted strings
 */
function splitStatements(content: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;
  let inLineComment = false;
  let inString = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    // Line comment ends at newline
    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    // Start of line comment
    if (!inDollarQuote && !inString && ch === "-" && content[i + 1] === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }

    // Dollar quoting toggle
    if (!inString && ch === "$" && content[i + 1] === "$") {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i++;
      continue;
    }

    // String quoting
    if (!inDollarQuote && ch === "'") {
      inString = !inString;
      current += ch;
      continue;
    }

    // Statement delimiter
    if (ch === ";" && !inDollarQuote && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}
