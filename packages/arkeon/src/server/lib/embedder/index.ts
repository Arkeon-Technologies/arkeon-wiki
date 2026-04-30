// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedder runtime interface and selection (issue #47).
 *
 * `getEmbedder()` returns a singleton resolved at first use. The
 * resolution order is:
 *
 *   1. ARKEON_WIKI_EMBEDDER override (`mock` | `onnx`). Forces a
 *      specific backend; init failures still surface.
 *   2. ONNX (default). Bundled via @huggingface/transformers; model
 *      weights download on first use to ~/.arkeon-wiki/models/.
 *   3. Mock — only if ONNX init genuinely throws (e.g. unsupported
 *      platform). Tests force this explicitly via the env override.
 *
 * Mock is test-only in production runs. Every user gets real embeddings
 * once the model finishes downloading; during the warm-up window,
 * search returns `{model: "warming", hits: []}` so a query never
 * blocks on a 309 MB download.
 *
 * Each backend exposes the same shape: `embed(texts, kind) →
 * Float32Array[]`, a `modelId`, a `dim`, plus `state()` and `warmUp()`
 * for lifecycle. See types.ts for the full interface.
 */

export {
  type Embedder,
  type EmbedderKind,
  type EmbedderState,
  type EmbedKind,
  EMBEDDING_DIM,
} from "./types.js";

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
  if (override === "onnx") {
    const { OnnxEmbedder } = await import("./onnx.js");
    return new OnnxEmbedder();
  }

  // Default: ONNX. The MockEmbedder is only reached if ONNX init
  // throws synchronously here (e.g. dynamic import fails on an
  // unsupported platform). Async load failures surface later via
  // state() === "failed" and don't fall through to mock.
  try {
    const { OnnxEmbedder } = await import("./onnx.js");
    return new OnnxEmbedder();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[embedder] ONNX backend could not be constructed (${msg}). ` +
        `Falling back to mock — vector search will not be semantically meaningful. ` +
        `Set ARKEON_WIKI_EMBEDDER=mock to silence this warning, or report the ` +
        `error if you expected ONNX to work on your platform.`,
    );
    const { MockEmbedder } = await import("./mock.js");
    return new MockEmbedder();
  }
}

export { MockEmbedder } from "./mock.js";
export { OnnxEmbedder } from "./onnx.js";
