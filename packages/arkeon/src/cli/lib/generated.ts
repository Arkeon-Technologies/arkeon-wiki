// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";

import { apiRequest } from "./http.js";
import { config } from "./config.js";
import { credentials } from "./credentials.js";
import { resolveJsonInput, resolveTextInput } from "./input.js";
import { output } from "./output.js";

export type GeneratedField = {
  name: string;
  description: string;
  required: boolean;
  type: string;
  enumValues?: string[];
};

export type GeneratedOperation = {
  operationId: string;
  group: string;
  action: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  auth: string;
  pathParams: GeneratedField[];
  queryParams: GeneratedField[];
  bodyFields: GeneratedField[];
};

function optionKey(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function flagName(name: string): string {
  return name.replace(/_/g, "-");
}

async function parseScalar(value: unknown, type: string): Promise<unknown> {
  if (value === undefined) {
    return undefined;
  }
  const text = await resolveTextInput(String(value));
  if (type === "integer" || type === "number") {
    return Number(text);
  }
  if (type === "boolean") {
    return text === "true";
  }
  if (type === "object" || type === "array") {
    return await resolveJsonInput(String(value));
  }
  return text;
}

async function parseBodyData(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof options.data === "string") {
    const parsed = await resolveJsonInput(options.data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--data must resolve to a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }
  return {};
}

function buildPath(pathTemplate: string, params: Record<string, string>): string {
  let path = pathTemplate;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  return path;
}

function applyQuery(path: string, query: URLSearchParams): string {
  const value = query.toString();
  if (!value) {
    return path;
  }
  return `${path}?${value}`;
}

export function registerGeneratedGroup(group: Command, operations: GeneratedOperation[]): void {
  for (const operation of operations) {
    const signature = [operation.action, ...operation.pathParams.map((field) => `<${field.name}>`)].join(" ");
    const command = group
      .command(signature)
      .description(operation.summary)
      .addHelpText(
        "after",
        `\nAuth: ${operation.auth}\nRoute: ${operation.method} ${operation.path}`,
      );

    for (const field of operation.queryParams) {
      const enumText = field.enumValues?.length ? ` (${field.enumValues.join("|")})` : "";
      command.option(
        `--${flagName(field.name)} <value>`,
        `${field.description || field.name}${field.required ? " (required)" : ""}${enumText}`,
      );
    }

    if (operation.bodyFields.length > 0) {
      command.option("--data <json|@file|@->", "Request body JSON, @file, or @- for stdin");
    }

    for (const field of operation.bodyFields) {
      const enumText = field.enumValues?.length ? ` (${field.enumValues.join("|")})` : "";
      command.option(
        `--${flagName(field.name)} <value>`,
        `${field.description || field.name}${field.required ? " (required)" : ""}${enumText}${field.type === "object" || field.type === "array" ? " [inline JSON|@file|@-]" : ""}`,
      );
    }

    command.option("--raw", "Print the raw API response body");

    command.action(async (...args: unknown[]) => {
      const commandInstance = args.at(-1) as Command;
      const options = commandInstance.opts() as Record<string, unknown>;
      const positionals = args.slice(0, -1).map(String);

      try {
        if (operation.auth === "required") {
          credentials.requireApiKey();
        }

        const pathParamEntries = operation.pathParams.map((field, index) => [field.name, positionals[index] ?? ""] as const);
        const builtPath = buildPath(operation.path, Object.fromEntries(pathParamEntries));

        const query = new URLSearchParams();
        for (const field of operation.queryParams) {
          const value = options[optionKey(flagName(field.name))];
          if (value === undefined) {
            continue;
          }
          query.set(field.name, String(await parseScalar(value, field.type)));
        }

        let body: Record<string, unknown> | undefined;
        if (operation.bodyFields.length > 0) {
          body = await parseBodyData(options);
          for (const field of operation.bodyFields) {
            const value = options[optionKey(flagName(field.name))];
            if (value === undefined) {
              continue;
            }
            body[field.name] = await parseScalar(value, field.type);
          }
        }

        // Auto-inject default space_id from config when not explicitly provided
        const defaultSpaceId = config.get("spaceId");
        if (defaultSpaceId) {
          const hasBodySpaceId = operation.bodyFields.some((f) => f.name === "space_id");
          if (hasBodySpaceId && body && body.space_id === undefined) {
            body.space_id = defaultSpaceId;
          }
          const hasQuerySpaceId = operation.queryParams.some((f) => f.name === "space_id");
          if (hasQuerySpaceId && !query.has("space_id")) {
            query.set("space_id", defaultSpaceId);
          }
        }

        const response = await apiRequest<unknown>(applyQuery(builtPath, query), {
          method: operation.method,
          auth: operation.auth === "required" ? true : operation.auth === "optional" ? "optional" : false,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (options.raw) {
          process.stdout.write(`${JSON.stringify(response ?? null, null, 2)}\n`);
          return;
        }

        output.result({
          operation: `${operation.group}.${operation.action}`,
          auth: operation.auth,
          method: operation.method,
          path: builtPath,
          data: response ?? null,
        });
      } catch (error) {
        output.error(error, { operation: `${operation.group}.${operation.action}` });
        process.exitCode = 1;
      }
    });
  }
}
