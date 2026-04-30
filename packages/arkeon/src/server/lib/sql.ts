// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

type Row = Record<string, unknown>;

export interface SqlClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  query(text: string, params?: unknown[]): Promise<Row[]>;
}

let _db: DatabaseType | null = null;

export function initDb(path: string): DatabaseType {
  if (_db) return _db;
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // sqlite-vec must be loaded before any prepared statement that touches
  // vec0 functions or the migration that creates `chunk_vectors`. The
  // helper wraps db.loadExtension() with the right binary path resolved
  // from the platform-specific optional dependencies.
  try {
    sqliteVec.load(_db);
    _db.prepare("SELECT vec_version()").get();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load sqlite-vec extension: ${msg}. ` +
        `If you are running on an unsupported platform (e.g. Alpine/musl), ` +
        `embeddings will not work; rebuild against a supported runtime.`,
    );
  }

  return _db;
}

export function getDb(): DatabaseType {
  if (!_db) {
    const path = process.env.DATABASE_PATH;
    if (!path) throw new Error("DATABASE_PATH not set and database not initialised");
    return initDb(path);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Convert a tagged template into a SQL string with ? placeholders and a
 * flat array of parameter values.
 */
function buildFromTemplate(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; params: unknown[] } {
  let sql = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) {
      sql += "?";
      params.push(values[i]);
    }
  }
  return { sql, params };
}

/**
 * Convert Postgres-style positional params ($1, $2, ...) to SQLite ? params.
 * Returns the reordered params array matching the ? positions.
 */
function convertPositionalParams(
  text: string,
  params: unknown[],
): { sql: string; params: unknown[] } {
  // If the query already uses ? placeholders (no $N patterns), pass through
  if (!/\$\d+/.test(text)) {
    return { sql: text, params };
  }
  const ordered: unknown[] = [];
  const sql = text.replace(/\$(\d+)/g, (_match, num) => {
    ordered.push(params[Number(num) - 1]);
    return "?";
  });
  return { sql, params: ordered };
}

function parseJson(val: unknown): unknown {
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

/**
 * SQLite stores JSON as TEXT. When reading rows back, parse any column
 * that looks like a JSON object/array so callers get objects, not strings.
 */
function hydrateRow(row: Row): Row {
  const out: Row = {};
  for (const [key, val] of Object.entries(row)) {
    if (key === "properties" && typeof val === "string") {
      out[key] = parseJson(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function runQuery(sql: string, params: unknown[]): Row[] {
  const db = getDb();
  const trimmed = sql.trim();

  // Determine if this is a read or write query
  const isRead = /^(SELECT|PRAGMA|EXPLAIN|WITH\s)/i.test(trimmed);

  if (isRead) {
    const stmt = db.prepare(trimmed);
    const rows = stmt.all(...params) as Row[];
    return rows.map(hydrateRow);
  }

  // Write queries — check for RETURNING clause
  const hasReturning = /\bRETURNING\b/i.test(trimmed);
  if (hasReturning) {
    const stmt = db.prepare(trimmed);
    const rows = stmt.all(...params) as Row[];
    return rows.map(hydrateRow);
  }

  const stmt = db.prepare(trimmed);
  stmt.run(...params);
  return [];
}

// ── Transaction mutex ───────────────────────────────────────────────
//
// better-sqlite3 is single-connection and synchronous. If two async
// callers both enter withTransaction concurrently, the second BEGIN
// IMMEDIATE would hit SQLITE_BUSY. A simple queue serializes access.

let _txQueue: Promise<unknown> = Promise.resolve();

/**
 * Run a callback inside a transaction.
 * Automatically commits on success, rolls back on error.
 * Concurrent calls are serialized via a queue to prevent SQLITE_BUSY.
 */
export function withTransaction<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(createSql());
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  // Chain onto the queue so transactions never overlap
  const p = _txQueue.then(run, run);
  // Update the queue head, swallowing errors so a failed transaction
  // doesn't block subsequent ones
  _txQueue = p.catch(() => {});
  return p;
}

export function createSql(): SqlClient {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const built = buildFromTemplate(strings, values);
    return runQuery(built.sql, built.params);
  }) as unknown as SqlClient;

  sql.query = async (text: string, params: unknown[] = []) => {
    const converted = convertPositionalParams(text, params);
    return runQuery(converted.sql, converted.params);
  };

  return sql;
}
