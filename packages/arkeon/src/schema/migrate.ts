// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process schema migration runner (SQLite).
 *
 * The CLI's `arkeon start` command imports runMigrations() directly
 * instead of spawning a child process, which lets the CLI reason
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
import { initDb, closeDb, getDb } from "../server/lib/sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrateOptions {
  /** Path to the SQLite database file. */
  dbPath: string;
}

export async function runMigrations(opts: MigrateOptions): Promise<void> {
  console.log(`Deploying schema to: ${opts.dbPath}`);
  console.log("");

  const schemaDir = await locateSchemaDir();
  const files = (await readdir(schemaDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const db = initDb(opts.dbPath);

  let failed = false;

  for (const file of files) {
    const content = await readFile(join(schemaDir, file), "utf-8");
    const statements = splitStatements(content);
    process.stdout.write(`  ${file} ... `);

    let fileOk = true;

    try {
      // Run all statements for a migration file in a single transaction
      db.exec("BEGIN");
      for (const stmt of statements) {
        if (stmt.replace(/--[^\n]*/g, "").trim() === "") continue;
        db.exec(stmt);
      }
      db.exec("COMMIT");
    } catch (err: unknown) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        // Table/index already exists — idempotent, that's fine
      } else {
        console.log(`ERROR: ${msg}`);
        fileOk = false;
        failed = true;
      }
    }

    if (fileOk) {
      console.log("OK");
    }
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
