// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";

import { ApiError } from "./errors";
import { decodeCursor } from "./cursor";
import type { AppBindings } from "../types";

export function requireActor(c: Context<AppBindings>) {
  const actor = c.get("actor");
  if (!actor) {
    throw new ApiError(401, "authentication_required", "Authentication required");
  }
  return actor;
}

export function parseLimit(
  c: Context<AppBindings>,
  options: {
    defaultValue: number;
    maxValue: number;
  },
): number {
  const raw = c.req.query("limit");
  if (!raw) {
    return options.defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > options.maxValue) {
    throw new ApiError(400, "invalid_query", "Invalid limit", {
      limit: raw,
      max: options.maxValue,
    });
  }

  return parsed;
}

export function parseOptionalTimestamp(value: string | undefined, field: string): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "invalid_query", `Invalid ${field}`, {
      field,
      value,
    });
  }

  return date.toISOString();
}

export function parseCursorParam(c: Context<AppBindings>) {
  return decodeCursor(c.req.query("cursor"));
}

export async function parseJsonBody<T>(c: Context<AppBindings>): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}
