// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vitest setup for e2e tests. Forces the deterministic mock embedder
 * so we don't trigger a 309 MB ONNX model download on every CI run.
 *
 * Tests that explicitly want a different backend (e.g. the manual
 * ONNX e2e under test/manual/) set ARKEON_WIKI_EMBEDDER themselves
 * before the daemon starts.
 */

if (!process.env.ARKEON_WIKI_EMBEDDER) {
  process.env.ARKEON_WIKI_EMBEDDER = "mock";
}
