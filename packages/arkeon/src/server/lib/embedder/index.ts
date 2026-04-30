// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedder runtime interface and selection (issue #47).
 *
 * `getEmbedder()` returns a singleton resolved at first use. The
 * resolution order is:
 *
 *   1. ARKEON_WIKI_EMBEDDER override (mock | ollama). Forces a specific
 *      backend; throws if unavailable.
 *   2. Auto-detect: Ollama at localhost:11434 with the configured model
 *      already pulled (fastest path when present).
 *   3. Mock fallback. Logs a warning — vector search will be exercising
 *      the pipeline, not real semantics.
 *
 * The ONNX runtime (transformers.js + EmbeddingGemma-300M, model cache,
 * threadpool pinning) will land in a follow-up PR alongside the query
 * path. Until then, real embeddings require a local Ollama install.
 *
 * Each backend exposes the same shape: `embed(texts) → Float32Array[]`,
 * a `modelId` (used in entity_embeddings to detect stale rows when we
 * swap models), and a `dim` (used to validate writes against the
 * 256-dim vec0 schema).
 *
 * For tests we force the mock via env so CI doesn't depend on Ollama.
 */

export { type Embedder, type EmbedderKind, EMBEDDING_DIM } from "./types.js";

import { type Embedder, type EmbedderKind } from "./types.js";

let _embedder: Embedder | null = null;
let _resolution: Promise<Embedder> | null = null;

/**
 * Resolve the embedder once and cache the singleton. Concurrent calls
 * during the first resolution share the same promise.
 */
export function getEmbedder(): Promise<Embedder> {
  if (_embedder) return Promise.resolve(_embedder);
  if (_resolution) return _resolution;

  _resolution = resolveEmbedder().then((e) => {
    _embedder = e;
    return e;
  });
  return _resolution;
}

/**
 * Reset the cached singleton. Tests use this to switch backends between
 * runs; also called from CLI commands that change the backend env var.
 */
export function resetEmbedder(): void {
  _embedder = null;
  _resolution = null;
}

async function resolveEmbedder(): Promise<Embedder> {
  const override = process.env.ARKEON_WIKI_EMBEDDER as EmbedderKind | undefined;
  if (override === "mock") {
    const { MockEmbedder } = await import("./mock.js");
    return new MockEmbedder();
  }
  if (override === "ollama") {
    const { createOllamaEmbedder } = await import("./ollama.js");
    return createOllamaEmbedder();
  }

  // Auto-detect: Ollama if reachable with the model pulled, else mock.
  try {
    const { tryOllama } = await import("./ollama.js");
    const ollama = await tryOllama();
    if (ollama) return ollama;
  } catch {
    // fall through
  }

  console.warn(
    `[embedder] No real embedder available. Falling back to mock — ` +
      `vector search will exercise the pipeline only, not real semantics. ` +
      `Install Ollama (https://ollama.com) and pull the embeddinggemma ` +
      `model for real embeddings, or wait for the bundled ONNX runtime in #47.`,
  );
  const { MockEmbedder } = await import("./mock.js");
  return new MockEmbedder();
}

export { MockEmbedder } from "./mock.js";
