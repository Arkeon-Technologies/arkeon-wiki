// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID, webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";
import { expect } from "vitest";

// Load .env from repo root (covers PORT, DATABASE_URL, ADMIN_BOOTSTRAP_KEY, E2E_BASE_URL).
// Won't override env vars that are already set.
config({ path: resolve(import.meta.dirname, "../../../../.env") });

export const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:8000";

// Admin key set via ADMIN_BOOTSTRAP_KEY env var at server startup
export const adminApiKey = process.env.ADMIN_BOOTSTRAP_KEY ?? "ak_test_admin_key_e2e";

type RequestOptions = {
  method?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
};

export type CreatedActor = {
  id: string;
  apiKey: string;
};

export function uniqueName(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// --- HTTP helpers ---

export async function apiRequest(path: string, options: RequestOptions = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.apiKey) {
    headers.set("authorization", `ApiKey ${options.apiKey}`);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ?? null,
  });

  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (response.status !== 204 && contentType.includes("application/json")) {
    body = await response.json();
  } else if (response.status !== 204) {
    body = await response.text();
  }

  return { response, body };
}

export async function jsonRequest(path: string, options: RequestOptions & { json?: unknown } = {}) {
  const headers = {
    ...(options.headers ?? {}),
    ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
  };
  return apiRequest(path, {
    ...options,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body ?? null,
  });
}

export async function getJson(path: string, apiKey?: string) {
  const { response, body } = await apiRequest(path, { apiKey });
  return { response, body: body as Record<string, any> };
}

// --- Actor helpers ---

/** Create an actor via POST /actors */
export async function createActor(
  callerApiKey: string,
  options: {
    kind?: string;
    properties?: Record<string, unknown>;
  } = {},
): Promise<CreatedActor> {
  const { response, body } = await jsonRequest("/actors", {
    method: "POST",
    apiKey: callerApiKey,
    json: {
      kind: options.kind ?? "agent",
      properties: options.properties ?? { label: uniqueName("actor") },
    },
  });
  expect(response.status).toBe(201);
  const data = body as { actor: Record<string, any>; api_key: string };
  return {
    id: data.actor.id,
    apiKey: data.api_key,
  };
}

// --- Entity helpers ---

/**
 * Create a wiki entity via POST /wiki. This is the only public write
 * path for entities — the old POST /entities was removed in the
 * wiki-first rewrite.
 */
export async function createWiki(
  apiKey: string,
  label: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const { response, body } = await jsonRequest("/wiki", {
    method: "POST",
    apiKey,
    json: {
      label,
      keywords: [label],
      short_description: `${label} test wiki page.`,
      content,
      ...extra,
    },
  });
  expect(response.status).toBe(201);
  return (body as { wiki: Record<string, any> }).wiki;
}

/**
 * Stub — relationships can no longer be created via a public endpoint.
 * They are a side effect of publishing a wiki with [[links]].
 * Tests that need relationships should create a wiki with a
 * [[entity:TARGET_ID]] link.
 */
export async function createRelationship(
  _apiKey: string,
  _entityId: string,
  _predicate: string,
  _targetId: string,
  _properties: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  throw new Error(
    "createRelationship is no longer available — relationships are created " +
    "via the wiki pipeline. Use createWiki() with [[entity:TARGET_ID]] links.",
  );
}

/**
 * Legacy helper for tests that need a plain entity. Calls POST /wiki
 * with a minimal body. Prefer createWiki() for new tests.
 */
export async function createEntity(
  apiKey: string,
  type: string,
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const label = (properties.label as string) ?? type;
  return createWiki(apiKey, label, `Test wiki for ${label}`, {
    type,
    ...extra,
  });
}

// --- Space helpers ---

export async function createSpace(
  apiKey: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const { response, body } = await jsonRequest("/spaces", {
    method: "POST",
    apiKey,
    json: { name, ...extra },
  });
  expect(response.status).toBe(201);
  return (body as { space: Record<string, any> }).space;
}

export async function addEntityToSpace(apiKey: string, spaceId: string, entityId: string) {
  const { response, body } = await jsonRequest(`/spaces/${spaceId}/entities`, {
    method: "POST",
    apiKey,
    json: { entity_id: entityId },
  });
  expect(response.status).toBe(201);
  return body;
}

// --- Content helpers ---

export async function uploadDirectContent(apiKey: string, entityId: string, key: string, ver: number, content: string, filename?: string) {
  const { response, body } = await apiRequest(
    `/wiki/${entityId}/content?key=${encodeURIComponent(key)}&ver=${ver}${filename ? `&filename=${encodeURIComponent(filename)}` : ""}`,
    {
      method: "POST",
      apiKey,
      headers: { "content-type": "text/plain" },
      body: content,
    },
  );
  expect(response.status).toBe(200);
  return body as { cid: string; size: number; key: string; ver: number };
}

// --- Notification helpers ---

export async function waitForNotifications(apiKey: string, minCount = 1, since?: string, attempts = 10, delayMs = 300) {
  const sinceParam = since ? `?since=${encodeURIComponent(since)}` : "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { response, body } = await apiRequest(`/auth/me/inbox/count${sinceParam}`, { apiKey });
    if (response.status === 200 && (body as { count: number }).count >= minCount) {
      return body as { count: number };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return apiRequest(`/auth/me/inbox/count${sinceParam}`, { apiKey }).then(({ body }) => body as { count: number });
}

// --- CID helpers ---

function encodeVarint(value: number) {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function encodeBase32Lower(bytes: Uint8Array) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

export async function computeCidFromText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes));
  const version = Uint8Array.of(0x01);
  const codec = encodeVarint(0x55);
  const multihashCode = encodeVarint(0x12);
  const multihashLength = encodeVarint(digest.length);
  const cidBytes = new Uint8Array(
    version.length + codec.length + multihashCode.length + multihashLength.length + digest.length,
  );
  let offset = 0;
  cidBytes.set(version, offset); offset += version.length;
  cidBytes.set(codec, offset); offset += codec.length;
  cidBytes.set(multihashCode, offset); offset += multihashCode.length;
  cidBytes.set(multihashLength, offset); offset += multihashLength.length;
  cidBytes.set(digest, offset);
  return `b${encodeBase32Lower(cidBytes)}`;
}
