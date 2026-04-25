// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors.js";

/**
 * Map a better-sqlite3 SqliteError to an ApiError with meaningful status/code.
 * Returns null if the error is not a SQLite error.
 */
export function mapDatabaseError(err: unknown): ApiError | null {
  if (!(err instanceof Error)) return null;

  const code = (err as { code?: string }).code;
  if (!code || !code.startsWith("SQLITE_")) return null;

  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return new ApiError(
      409,
      "conflict",
      "A record with this value already exists",
    );
  }

  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
    return new ApiError(
      400,
      "invalid_reference",
      "Referenced record does not exist",
    );
  }

  if (code === "SQLITE_CONSTRAINT_NOTNULL") {
    return new ApiError(
      400,
      "missing_field",
      "A required field is missing",
    );
  }

  if (code === "SQLITE_CONSTRAINT_CHECK") {
    return new ApiError(
      400,
      "validation_error",
      "Value violates a check constraint",
    );
  }

  if (code === "SQLITE_CANTOPEN" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return new ApiError(
      503,
      "service_unavailable",
      "Database is temporarily unavailable",
    );
  }

  return new ApiError(500, "internal_error", "Internal server error");
}
