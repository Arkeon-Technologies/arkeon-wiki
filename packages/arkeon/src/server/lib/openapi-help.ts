// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type OpenAPISpec as SharedOpenAPISpec,
  type GeneratedField,
  type GeneratedOperation,
  parseOperations,
} from "../../shared";

import type { Actor } from "../types";

export function renderPreamble(actor: Actor | null): string {
  const lines: string[] = [];

  if (!actor) {
    lines.push("# Arkeon API");
    lines.push("#");
    lines.push("# Authenticate with X-API-Key: <key> to see personalized guidance.");
    lines.push("# See GET /help/guide for a getting-started walkthrough.");
    lines.push("");
    return lines.join("\n");
  }

  const name = actor.label ?? actor.keyPrefix;
  lines.push(`# Arkeon API`);
  lines.push(`#`);
  lines.push(`# You are authenticated as: ${name}`);
  lines.push(`# Clearance: read=${actor.maxReadLevel} write=${actor.maxWriteLevel}`);
  lines.push(`#`);
  lines.push(`# New here? See GET /help/guide for a getting-started walkthrough.`);

  if (actor.isAdmin) {
    lines.push(`# Admin? See GET /help/guide/admin for network setup, actors, and classification.`);
  }

  lines.push("");
  return lines.join("\n");
}

// SDK docs + filter syntax preamble for /llms.txt
// Response patterns are injected dynamically from the OpenAPI spec
const LLMS_PREAMBLE = [
  "# Arkeon API — Route Index",
  "# Auth: X-API-Key: <key> (preferred) or Authorization: ApiKey <key> — prefixes uk_ (user) or kk_ (klados)",
  "# Detail: GET /help/<METHOD>/<path> for full docs on any route",
  "# Example: GET /help/GET/entities/{id}",
  "# Guides: GET /help/guide (basics), /help/guide/wiki (authoring), /help/guide/explorer (visual)",
  "#",
  "",
  "## SDKs",
  "",
  "Auth is automatic from ARKE_API_URL + ARKE_API_KEY env vars. Zero config.",
  "Paths and body fields are identical to the API reference below.",
  "",
  "### TypeScript (@arkeon-technologies/sdk)",
  "",
  "  import * as arkeon from '@arkeon-technologies/sdk';",
  "",
  "  // HTTP methods",
  "  await arkeon.get('/entities', { params: { limit: '10', filter: 'type:note' } });",
  "  await arkeon.post('/entities', { type: 'note', properties: { label: 'Hello' } });",
  "  await arkeon.put(`/entities/${id}`, { ver: 1, properties: { label: 'Updated' } });",
  "  await arkeon.del(`/entities/${id}`);",
  "",
  "  // Relationships — source in path, target in body",
  "  await arkeon.post(`/entities/${sourceId}/relationships`, {",
  "    predicate: 'references', target_id: targetId,",
  "  });",
  "",
  "  // Pagination — async generator, yields items across all pages",
  "  for await (const e of arkeon.paginate('/entities', { limit: '50' })) { ... }",
  "",
  "  // Configuration",
  "  arkeon.setSpaceId('01XYZ...');  // or ARKE_SPACE_ID env var",
  "",
  "  // Errors: ArkeError { status, code, requestId, details }",
  "",
  "Notes: get(path, { params }) / post(path, body) / put(path, body) / del(path)  [del, not delete]",
  "put/patch require `ver` in body (optimistic concurrency — 409 if stale)",
  "",
  "## Graph Explorer",
  "",
  "Open entities in the visual graph explorer:",
  "  https://app.arkeon.tech/explore?instance=<hostname>&entity=<entityId>",
  "",
  "Parameters:",
  "  instance*   Hostname (e.g. my-network.arkeon.tech)",
  "  key         API key (omit for public access)",
  "  entity      Single entity ID to view",
  "  entities    Comma-separated entity IDs to seed into graph",
  "  select      Entity ID to focus initially",
  "  mode        'graph' (default) or 'feed'",
  "",
  "This URL is for human browsers. LLM agents should surface the URL",
  "to the caller rather than attempting to open it.",
  "",
];

const LLMS_FILTER_SYNTAX = [
  "## Filter Syntax",
  "# Use the `filter` query param on any listing endpoint.",
  "# Format: filter=field<op>value,field<op>value (comma-separated, AND'd)",
  "#",
  "# Operators:",
  "#   :   equals         kind:entity",
  "#   !:  not equals     kind!:relationship",
  "#   >   greater than   created_at>2026-01-01",
  "#   >=  greater/equal  ver>=2",
  "#   <   less than      updated_at<2026-06-01",
  "#   <=  less/equal     ver<=5",
  "#   ?   exists         label?",
  "#   !?  missing        description!?",
  "#",
  "# Entity columns (filter directly on the schema):",
  "#   kind            text       entity | relationship",
  "#   type            text       semantic type (book, person, etc.)",
  "#   ver             numeric    content version number",
  "#   owner_id        text       owner actor ULID",
  "#   read_level      numeric    classification level (0-4)",
  "#   write_level     numeric    write ceiling (0-4)",
  "#   edited_by       text       last editor ULID",
  "#   created_at      timestamp  ISO 8601",
  "#   updated_at      timestamp  ISO 8601",
  "#",
  "# Property paths (filter on properties JSONB):",
  "#   label:Neuroscience          exact match on properties.label",
  "#   metadata.source:arxiv       nested path",
  "#   year>2020                   numeric comparison (non-column paths)",
  "#",
  "# Relationship filters (filter by graph connections):",
  "#   rel.<predicate>:<entity_id>      entities with this relationship (either direction)",
  "#   rel_out.<predicate>:<entity_id>  entities that are the source of this relationship",
  "#   rel_in.<predicate>:<entity_id>   entities that are the target of this relationship",
  "#   Use !: for negation: rel.extracted_from!:<id> = no such relationship",
  "#",
  "#   Example: filter=rel.extracted_from:01ABC returns all entities",
  "#   that have an extracted_from relationship to entity 01ABC.",
  "#",
  "# Examples:",
  "#   filter=kind:entity,type:book,created_at>2026-01-01",
  "#   filter=owner_id:01ABC,read_level<=2",
  "#   filter=kind!:relationship,language:English",
  "#   filter=rel.extracted_from:01ABC,type:character",
  "",
];

type OpenAPISpec = {
  components?: {
    schemas?: Record<string, unknown>;
  };
  paths?: Record<string, unknown>;
};

type OperationMatch = {
  method: string;
  path: string;
  operation: Record<string, unknown>;
};

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

function resolveSchema(spec: OpenAPISpec, schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) {
    return undefined;
  }
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const name = ref.split("/").pop() ?? "";
    return resolveSchema(spec, spec.components?.schemas?.[name] as Record<string, unknown> | undefined);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = { type: "object", properties: {}, required: [] };
    for (const item of schema.allOf as Array<Record<string, unknown>>) {
      const resolved = resolveSchema(spec, item);
      if (!resolved) {
        continue;
      }
      Object.assign(merged.properties as Record<string, unknown>, (resolved.properties as Record<string, unknown>) ?? {});
      if (Array.isArray(resolved.required)) {
        (merged.required as unknown[]).push(...resolved.required);
      }
    }
    return merged;
  }
  return schema;
}

function schemaType(spec: OpenAPISpec, schema: Record<string, unknown> | undefined): string {
  const resolved = resolveSchema(spec, schema);
  if (!resolved) {
    return "unknown";
  }
  if (Array.isArray(resolved.oneOf)) {
    return (resolved.oneOf as Array<Record<string, unknown>>).map((item) => schemaType(spec, item)).join(" | ");
  }
  if (Array.isArray(resolved.anyOf)) {
    return (resolved.anyOf as Array<Record<string, unknown>>).map((item) => schemaType(spec, item)).join(" | ");
  }
  if (resolved.type === "array") {
    return `Array<${schemaType(spec, resolved.items as Record<string, unknown> | undefined)}>`;
  }
  if (Array.isArray(resolved.enum)) {
    return (resolved.enum as unknown[]).map(String).join(" | ");
  }
  if (resolved.type === "object" && resolved.additionalProperties) {
    return "object";
  }
  const type = typeof resolved.type === "string" ? resolved.type : "object";
  if (resolved.nullable) {
    return `${type} | null`;
  }
  return type;
}

function renderSchemaFields(spec: OpenAPISpec, schema: Record<string, unknown> | undefined, includeRequired = true): string[] {
  const resolved = resolveSchema(spec, schema);
  if (!resolved) {
    return [];
  }
  const properties = (resolved.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(resolved.required) ? (resolved.required as string[]) : []);
  return Object.entries(properties).map(([name, propertySchema]) => {
    const description = typeof propertySchema.description === "string" ? propertySchema.description : "";
    const suffix = description ? ` — ${description}` : "";
    const marker = includeRequired && required.has(name) ? "*" : "";
    return `  ${name}${marker}: ${schemaType(spec, propertySchema)}${suffix}`;
  });
}

function getOperation(spec: OpenAPISpec, method: string, path: string): OperationMatch | undefined {
  const normalizedMethod = method.toLowerCase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const operation = (spec.paths?.[normalizedPath] as Record<string, Record<string, unknown>> | undefined)?.[normalizedMethod];
  if (!operation) {
    return undefined;
  }
  return { method: normalizedMethod, path: normalizedPath, operation };
}

function listOperations(spec: OpenAPISpec): OperationMatch[] {
  const results: OperationMatch[] = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths ?? {})) {
    const pathItem = rawPathItem as Record<string, Record<string, unknown>>;
    for (const method of METHOD_ORDER) {
      const operation = pathItem[method];
      if (operation) {
        results.push({ method, path, operation });
      }
    }
  }
  return results;
}

function findRelatedSummary(spec: OpenAPISpec, value: string): string | undefined {
  const [method, ...pathParts] = value.split(" ");
  const path = pathParts.join(" ");
  const match = getOperation(spec, method, path);
  return typeof match?.operation.summary === "string" ? match.operation.summary : undefined;
}

function buildLlmsPreamble(): string[] {
  return [
    ...LLMS_PREAMBLE,
    "## Responses",
    "",
    "IMPORTANT: API responses wrap objects in a named key. Never access .id directly.",
    "Each endpoint below includes a Response section showing the exact field names and types.",
    "  Example: resp.entity.id (NOT resp.id) — always use the wrapper key first.",
    "",
    ...LLMS_FILTER_SYNTAX,
  ];
}

export function renderIndexFromSpec(spec: OpenAPISpec): string {
  const lines = buildLlmsPreamble();
  const grouped = new Map<string, OperationMatch[]>();

  for (const match of listOperations(spec)) {
    const section = match.path.split("/")[1] ?? "other";
    const list = grouped.get(section) ?? [];
    list.push(match);
    grouped.set(section, list);
  }

  for (const [section, matches] of grouped) {
    lines.push(`## ${section}`);
    for (const match of matches) {
      const summary = typeof match.operation.summary === "string" ? match.operation.summary : "";
      const auth = String(match.operation["x-arke-auth"] ?? "optional");
      const ruleCount = Array.isArray(match.operation["x-arke-rules"])
        ? (match.operation["x-arke-rules"] as unknown[]).length
        : 0;
      const rulesTag = ruleCount > 0 ? ` [${ruleCount} rules]` : "";
      lines.push(
        `${match.method.toUpperCase().padEnd(6)} ${match.path.padEnd(40)} ${auth.padEnd(10)} ${summary}${rulesTag}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderRouteHelpFromSpec(spec: OpenAPISpec, method: string, path: string): string | null {
  const match = getOperation(spec, method, path);
  if (!match) {
    return null;
  }

  const { operation } = match;
  const rules = Array.isArray(operation["x-arke-rules"])
    ? (operation["x-arke-rules"] as string[])
    : [];

  const lines: string[] = [
    `${match.method.toUpperCase()} ${match.path}`,
    `Auth: ${String(operation["x-arke-auth"] ?? "optional")}`,
    `Summary: ${String(operation.summary ?? "")}`,
  ];

  if (rules.length) {
    lines.push("");
    lines.push("Permission Rules:");
    for (const rule of rules) {
      lines.push(`  - ${rule}`);
    }
  }

  lines.push("");

  const parameters = Array.isArray(operation.parameters)
    ? (operation.parameters as Array<Record<string, unknown>>)
    : [];

  const pathParams = parameters.filter((parameter) => parameter.in === "path");
  if (pathParams.length) {
    lines.push("Path params:");
    for (const parameter of pathParams) {
      const name = String(parameter.name ?? "");
      const required = parameter.required ? "*" : "";
      const description = String(parameter.description ?? "");
      lines.push(`  ${name}${required} — ${description}`);
    }
    lines.push("");
  }

  const queryParams = parameters.filter((parameter) => parameter.in === "query");
  if (queryParams.length) {
    lines.push("Query params:");
    for (const parameter of queryParams) {
      const name = String(parameter.name ?? "");
      const required = parameter.required ? "*" : "";
      const description = String(parameter.description ?? "");
      lines.push(`  ${name}${required} — ${description}`);
    }
    lines.push("");
  }

  const requestBody = operation.requestBody as Record<string, unknown> | undefined;
  const requestSchema = resolveSchema(
    spec,
    (((requestBody?.content as Record<string, Record<string, unknown>> | undefined)?.["application/json"] ??
      Object.values((requestBody?.content as Record<string, Record<string, unknown>> | undefined) ?? {})[0]) as
      | Record<string, unknown>
      | undefined)?.schema as Record<string, unknown> | undefined,
  );

  const bodyFields = renderSchemaFields(spec, requestSchema);
  if (bodyFields.length) {
    lines.push("Request body (JSON):");
    lines.push(...bodyFields);
    lines.push("");
  }

  const responses = (operation.responses ?? {}) as Record<string, Record<string, unknown>>;
  const primaryResponse =
    Object.entries(responses).find(([status]) => status.startsWith("2"))?.[1] ??
    Object.values(responses)[0];
  const responseSchema = resolveSchema(
    spec,
    (((primaryResponse?.content as Record<string, Record<string, unknown>> | undefined)?.["application/json"] ??
      Object.values((primaryResponse?.content as Record<string, Record<string, unknown>> | undefined) ?? {})[0]) as
      | Record<string, unknown>
      | undefined)?.schema as Record<string, unknown> | undefined,
  );
  const responseFields = renderSchemaFields(spec, responseSchema, false);
  if (responseFields.length) {
    lines.push("Response:");
    lines.push(...responseFields);
    lines.push("");
  }

  const related = Array.isArray(operation["x-arke-related"])
    ? (operation["x-arke-related"] as string[])
    : [];
  if (related.length) {
    lines.push("Related:");
    for (const value of related) {
      const summary = findRelatedSummary(spec, value);
      lines.push(summary ? `  ${value} — ${summary}` : `  ${value}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full API reference for /llms.txt
// ---------------------------------------------------------------------------

function renderApiFieldLine(field: GeneratedField): string {
  const req = field.required ? "*" : "";
  const enumText = field.enumValues?.length ? ` (${field.enumValues.join("|")})` : "";
  const desc = field.description || field.name;
  const name = `${field.name}${req}`;
  return `  ${name.padEnd(22)} ${field.type.padEnd(10)} ${desc}${enumText}`;
}

function renderApiOperationBlock(op: GeneratedOperation): string {
  const lines: string[] = [
    `### ${op.method} ${op.path}`,
    `Auth: ${op.auth}`,
    op.summary,
  ];

  if (op.pathParams.length) {
    lines.push("");
    lines.push("Path params:");
    for (const p of op.pathParams) {
      lines.push(renderApiFieldLine(p));
    }
  }

  if (op.queryParams.length) {
    lines.push("");
    lines.push("Query params:");
    for (const f of op.queryParams) {
      lines.push(renderApiFieldLine(f));
    }
  }

  if (op.bodyFields.length) {
    lines.push("");
    lines.push("Request body (JSON):");
    for (const f of op.bodyFields) {
      lines.push(renderApiFieldLine(f));
    }
  }

  if (op.responseFields.length) {
    lines.push("");
    lines.push("Response:");
    for (const f of op.responseFields) {
      lines.push(renderApiFieldLine(f));
    }
  }

  if (op.rules.length) {
    lines.push("");
    lines.push("Rules:");
    for (const rule of op.rules) {
      lines.push(`  - ${rule}`);
    }
  }

  return lines.join("\n");
}

/**
 * Renders a comprehensive HTTP API reference from the OpenAPI spec.
 * Every operation is shown with method, path, all parameters,
 * request body fields, types, descriptions, and permission rules.
 *
 * Used for /llms.txt so external LLMs get complete API knowledge in one fetch.
 */
export function renderFullApiReferenceFromSpec(spec: SharedOpenAPISpec): string {
  const operations = parseOperations(spec);

  // Group by first path segment (matches the /help index grouping)
  const grouped = new Map<string, GeneratedOperation[]>();
  for (const op of operations) {
    const section = op.path.split("/")[1] ?? "other";
    const list = grouped.get(section) ?? [];
    list.push(op);
    grouped.set(section, list);
  }

  const sections: string[] = buildLlmsPreamble();

  for (const [section, ops] of grouped) {
    sections.push(`## ${section}`);
    sections.push("");
    for (const op of ops) {
      sections.push(renderApiOperationBlock(op));
      sections.push("");
    }
  }

  return sections.join("\n");
}

export function renderRouteNotFoundFromSpec(spec: OpenAPISpec, method: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const suggestions = listOperations(spec)
    .filter(
      (match) =>
        match.path.includes(normalizedPath) ||
        normalizedPath.includes(match.path.split("/")[1] ?? "") ||
        match.method === method.toLowerCase(),
    )
    .slice(0, 5)
    .map((match) => `  ${match.method.toUpperCase()} ${match.path} — ${String(match.operation.summary ?? "")}`);

  let body = `Route not found: ${method.toUpperCase()} ${normalizedPath}\n`;
  if (suggestions.length) {
    body += `\nDid you mean:\n${suggestions.join("\n")}\n`;
  }
  body += "\nSee GET /help for the full route index.\n";
  return body;
}
