// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-function tests for the api-client helpers. The network /
 * exit-code paths through `apiCall` are exercised end-to-end via the
 * substrate e2e suite and manual smoke; here we just nail down the
 * small composable pieces.
 */

import { describe, expect, it } from "vitest";

import {
  authHeader,
  buildUrl,
  cleanRequestBody,
} from "../../src/cli/lib/api-client.js";

describe("buildUrl", () => {
  it("joins base and path with no surprises", () => {
    expect(buildUrl("http://localhost:8062", "/query")).toBe(
      "http://localhost:8062/query",
    );
  });

  it("tolerates a trailing slash on the base", () => {
    expect(buildUrl("http://localhost:8062/", "/query")).toBe(
      "http://localhost:8062/query",
    );
  });

  it("tolerates a missing leading slash on the path", () => {
    expect(buildUrl("http://localhost:8062", "query")).toBe(
      "http://localhost:8062/query",
    );
  });

  it("attaches query params and URL-encodes them", () => {
    const url = buildUrl("http://localhost:8062", "/tags", {
      path: "iarpa/article with spaces.html",
    });
    // URL serializes spaces as `+` in query strings (form-encoding).
    expect(url).toBe(
      "http://localhost:8062/tags?path=iarpa%2Farticle+with+spaces.html",
    );
  });

  it("drops null and undefined query params (treats them as 'unset')", () => {
    const url = buildUrl("http://localhost:8062", "/redlinks", {
      folder: "iarpa",
      limit: undefined,
      offset: null,
    });
    expect(url).toBe("http://localhost:8062/redlinks?folder=iarpa");
  });

  it("coerces numeric query params to strings", () => {
    expect(buildUrl("http://x", "/y", { limit: 50 })).toBe(
      "http://x/y?limit=50",
    );
  });
});

describe("authHeader", () => {
  it("emits no header when no token is configured", () => {
    expect(authHeader({ env: {} })).toEqual({});
  });

  it("prefers an explicit --token over the env var", () => {
    expect(
      authHeader({ token: "flag-token", env: { ARKEON_WIKI_TOKEN: "env-token" } }),
    ).toEqual({ authorization: "Bearer flag-token" });
  });

  it("falls back to ARKEON_WIKI_TOKEN from the injected env", () => {
    expect(authHeader({ env: { ARKEON_WIKI_TOKEN: "env-token" } })).toEqual({
      authorization: "Bearer env-token",
    });
  });
});

describe("cleanRequestBody", () => {
  it("returns undefined when no body is supplied (GET requests)", () => {
    expect(cleanRequestBody(undefined)).toBeUndefined();
  });

  it("strips undefined fields (skipped optional flags)", () => {
    const out = cleanRequestBody({ folder: "iarpa", limit: undefined });
    expect(JSON.parse(out!)).toEqual({ folder: "iarpa" });
  });

  it("strips null fields", () => {
    const out = cleanRequestBody({ folder: "iarpa", limit: null });
    expect(JSON.parse(out!)).toEqual({ folder: "iarpa" });
  });

  it("preserves false, 0, and empty strings — only null/undefined drop", () => {
    const out = cleanRequestBody({
      flag: false,
      count: 0,
      empty: "",
      missing: undefined,
    });
    expect(JSON.parse(out!)).toEqual({ flag: false, count: 0, empty: "" });
  });

  it("preserves arrays (has_tag, not_tag, kinds)", () => {
    const out = cleanRequestBody({ has_tag: ["status:reviewed", "topic:x"] });
    expect(JSON.parse(out!)).toEqual({
      has_tag: ["status:reviewed", "topic:x"],
    });
  });

  it("returns '{}' for a body containing only undefined/null", () => {
    expect(cleanRequestBody({ a: undefined, b: null })).toBe("{}");
  });
});
