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
import { initDb } from "../server/lib/sql.js";

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

  // v0 → v1 detector. v0 shipped `entities`/`relationships`/`spaces`/
  // `entity_edits`; v1 ships `artifacts`/`tags`/`links`/`fts_artifacts`.
  // If the DB has the v0 shape, the migration ledger says
  // `001-foundation.sql` is already applied (but the v1 file is a
  // totally different schema), so we'd skip it and start INSERTing
  // into tables that don't exist. Fail loud with an actionable hint.
  const tables = new Set(
    (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[]).map((r) => r.name),
  );
  if (tables.has("entities") && !tables.has("artifacts")) {
    throw new Error(
      `v0 schema detected at ${opts.dbPath}. v1 is a destructive reset — ` +
        `the DB is a pure index of filesystem state and rebuilds in seconds. ` +
        `Run: rm "${opts.dbPath}" && arkeon-wiki up`,
    );
  }

  // Bootstrap the migration ledger so subsequent runs can skip applied
  // files. Without this, every migration must be naturally idempotent
  // (CREATE TABLE IF NOT EXISTS); with it, non-idempotent recreates
  // (e.g. dropping a CHECK constraint via the SQLite 12-step) are safe.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[])
      .map((r) => r.name),
  );

  // Bootstrap mode: the ledger is empty, so this is the first run on
  // either a fresh DB or a pre-ledger DB whose 001-N migrations were
  // already applied via the old IF-NOT-EXISTS pattern. Only in this
  // mode is it safe to auto-record an "already exists" failure as
  // applied — outside of bootstrap, "already exists" indicates a real
  // failure (a partially-applied non-idempotent migration, manual DB
  // tampering, or a logic bug) and must surface, not get swallowed.
  const isBootstrap = applied.size === 0;

  let failed = false;

  for (const file of files) {
    process.stdout.write(`  ${file} ... `);

    if (applied.has(file)) {
      console.log("SKIP (already applied)");
      continue;
    }

    const content = await readFile(join(schemaDir, file), "utf-8");
    const statements = splitStatements(content);

    let fileOk = true;

    try {
      // Run all statements for a migration file in a single transaction
      db.exec("BEGIN");
      for (const stmt of statements) {
        if (stmt.replace(/--[^\n]*/g, "").trim() === "") continue;
        db.exec(stmt);
      }
      db.prepare("INSERT INTO schema_migrations(name) VALUES (?)").run(file);
      db.exec("COMMIT");
    } catch (err: unknown) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") && isBootstrap) {
        // Pre-ledger DB: the file's CREATE TABLE IF NOT EXISTS already
        // matched. Record it as applied so the next run skips cleanly.
        // Gated on isBootstrap so a future non-idempotent migration that
        // partial-applied (or hits "already exists" for any other reason)
        // surfaces loudly instead of being silently marked applied.
        try {
          db.prepare("INSERT OR IGNORE INTO schema_migrations(name) VALUES (?)").run(file);
        } catch { /* ignore */ }
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
