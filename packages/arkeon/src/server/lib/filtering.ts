// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors";

const FILTER_RE = /^([a-zA-Z_][a-zA-Z0-9_.]*)(!:|!\?|>=|<=|>|<|:|\?)(.*)$/;

export interface FilterClause {
  path: string;
  op: string;
  value: string;
}

// Top-level entity columns exposed to the filter API.
// If a filter path matches one of these, it targets the column directly
// instead of drilling into the properties JSONB.
const COLUMN_WHITELIST: Record<string, "text" | "numeric" | "timestamp"> = {
  kind: "text",
  type: "text",
  ver: "numeric",
  owner_id: "text",
  edited_by: "text",
  created_at: "timestamp",
  updated_at: "timestamp",
};

/** Column names available in the filter API, exported for help docs. */
export const FILTERABLE_COLUMNS = Object.entries(COLUMN_WHITELIST).map(
  ([name, type]) => ({ name, type }),
);

/** Relationship filter prefixes available in the filter API, exported for help docs. */
export const RELATIONSHIP_FILTER_PREFIXES = [
  { prefix: "rel.<predicate>", description: "Entities with a relationship (either direction) of this predicate to the given entity ID" },
  { prefix: "rel_out.<predicate>", description: "Entities that are the source of a relationship with this predicate to the given entity ID" },
  { prefix: "rel_in.<predicate>", description: "Entities that are the target of a relationship with this predicate from the given entity ID" },
];

export function parseFilter(filter: string | undefined): FilterClause[] {
  if (!filter) {
    return [];
  }

  return filter.split(",").map((expression) => {
    const trimmed = expression.trim();
    const match = trimmed.match(FILTER_RE);
    if (!match) {
      throw new ApiError(400, "invalid_filter", "Invalid filter expression", {
        filter: trimmed,
      });
    }

    const [, path, op, value] = match;
    return { path, op, value };
  });
}

function jsonPathArray(path: string): string {
  return `{${path.split(".").join(",")}}`;
}

function buildColumnClause(
  column: string,
  columnType: "text" | "numeric" | "timestamp",
  op: string,
  value: string,
  params: unknown[],
  paramIndex: number,
): { sql: string; nextIndex: number } {
  switch (op) {
    case ":":
      params.push(value);
      return { sql: `${column} = $${paramIndex}`, nextIndex: paramIndex + 1 };
    case "!:":
      params.push(value);
      return { sql: `${column} != $${paramIndex}`, nextIndex: paramIndex + 1 };
    case ">":
    case ">=":
    case "<":
    case "<=":
      if (columnType === "text") {
        throw new ApiError(400, "invalid_filter", `Numeric/timestamp operator ${op} not supported on text column ${column}`);
      }
      params.push(value);
      if (columnType === "timestamp") {
        return { sql: `${column} ${op} $${paramIndex}::timestamptz`, nextIndex: paramIndex + 1 };
      }
      return { sql: `${column} ${op} $${paramIndex}::numeric`, nextIndex: paramIndex + 1 };
    case "?":
      return { sql: `${column} IS NOT NULL`, nextIndex: paramIndex };
    case "!?":
      return { sql: `${column} IS NULL`, nextIndex: paramIndex };
    default:
      throw new ApiError(400, "invalid_filter", "Invalid filter operator", {
        filter: `${column}${op}${value}`,
      });
  }
}

export function buildFilterSql(
  filter: string | undefined,
  params: unknown[],
  startIndex: number,
): { sql: string[]; nextIndex: number } {
  const clauses = parseFilter(filter);
  const sql: string[] = [];
  let nextIndex = startIndex;

  for (const clause of clauses) {
    // Relationship filter: rel.<predicate>:<target_id>
    // Matches entities that have a relationship with the given predicate
    // to/from the specified entity. Supports directional variants:
    //   rel.<pred>:<id>     — either direction
    //   rel_out.<pred>:<id> — this entity is the source
    //   rel_in.<pred>:<id>  — this entity is the target
    const relMatch = clause.path.match(/^(rel|rel_out|rel_in)\.(.+)$/);
    if (relMatch && (clause.op === ":" || clause.op === "!:")) {
      const [, direction, predicate] = relMatch;
      const entityId = clause.value;
      params.push(predicate, entityId);
      const predIdx = nextIndex;
      const idIdx = nextIndex + 1;
      nextIndex += 2;

      let directionSql: string;
      // Use entities.id explicitly to avoid ambiguity with relationship_edges.id
      if (direction === "rel_out") {
        // This entity is the source, value is the target
        directionSql = `re_f.source_id = entities.id AND re_f.target_id = $${idIdx}`;
      } else if (direction === "rel_in") {
        // This entity is the target, value is the source
        directionSql = `re_f.target_id = entities.id AND re_f.source_id = $${idIdx}`;
      } else {
        // Either direction
        directionSql = `(re_f.source_id = entities.id AND re_f.target_id = $${idIdx}) OR (re_f.target_id = entities.id AND re_f.source_id = $${idIdx})`;
      }

      const existsClause = `${clause.op === "!:" ? "NOT " : ""}EXISTS (
        SELECT 1 FROM relationship_edges re_f
        WHERE re_f.predicate = $${predIdx} AND (${directionSql})
      )`;
      sql.push(existsClause);
      continue;
    }

    const columnType = COLUMN_WHITELIST[clause.path];

    if (columnType) {
      // Top-level column filter
      const result = buildColumnClause(
        clause.path,
        columnType,
        clause.op,
        clause.value,
        params,
        nextIndex,
      );
      sql.push(result.sql);
      nextIndex = result.nextIndex;
      continue;
    }

    // Property JSONB filter — strip leading "properties." since we already
    // target the properties column (LLMs naturally use the full response path).
    const normalizedPath = clause.path.startsWith("properties.")
      ? clause.path.slice("properties.".length)
      : clause.path;
    const pathText = jsonPathArray(normalizedPath);
    switch (clause.op) {
      case ":":
        params.push(clause.value);
        sql.push(`properties #>> '${pathText}' = $${nextIndex}`);
        nextIndex += 1;
        break;
      case "!:":
        params.push(clause.value);
        sql.push(`properties #>> '${pathText}' != $${nextIndex}`);
        nextIndex += 1;
        break;
      case ">":
      case ">=":
      case "<":
      case "<=":
        params.push(clause.value);
        sql.push(`(properties #>> '${pathText}')::numeric ${clause.op} $${nextIndex}`);
        nextIndex += 1;
        break;
      case "?":
        sql.push(`properties #> '${pathText}' IS NOT NULL`);
        break;
      case "!?":
        sql.push(`properties #> '${pathText}' IS NULL`);
        break;
      default:
        throw new ApiError(400, "invalid_filter", "Invalid filter expression", {
          filter: `${clause.path}${clause.op}${clause.value}`,
        });
    }
  }

  return { sql, nextIndex };
}
