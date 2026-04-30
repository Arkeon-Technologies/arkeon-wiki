// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedder types and shared constants. Lives in its own module so
 * concrete backends (mock, onnx) can import without pulling in the
 * resolver and creating a cycle.
 */

/**
 * Whether a text is being embedded as a stored chunk (`document`) or as
 * the user's search query (`query`). Some models — notably
 * EmbeddingGemma — apply different instruction prefixes for each role
 * and silently degrade recall if you skip them. The ONNX backend
 * applies the right prefix internally; the mock ignores `kind`.
 */
export type EmbedKind = "document" | "query";

/**
 * Lifecycle state of the underlying model. The ONNX backend reports
 * `warming` while it's downloading or loading weights, transitions to
 * `ready` once it can serve `embed()`, and to `failed` if the load
 * threw (e.g. network error on first download). Mock is always `ready`.
 *
 * Search consumers check this before issuing a query so the user gets
 * `{model: "warming", hits: []}` instead of a multi-second hang.
 */
export type EmbedderState = "warming" | "ready" | "failed";

export interface Embedder {
  /** Stable identifier of the model+dim pair, e.g. "onnx:embeddinggemma-300m@256". */
  readonly modelId: string;
  /** Vector dimensionality. Asserted to match the vec0 schema (256). */
  readonly dim: number;
  /** Snapshot of the embedder's lifecycle state. */
  state(): EmbedderState;
  /**
   * Begin loading the model in the background. Idempotent — calling
   * twice doesn't re-trigger the download. Returns a promise that
   * resolves once the embedder transitions to `ready` (or rejects if
   * it fails). The daemon kicks this off at startup so the model is
   * ready by the time the first user query arrives.
   */
  warmUp(): Promise<void>;
  /** Embed a batch. Returned vectors are length === dim. */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

/** Vec0 column dimension. Don't change without a schema migration. */
export const EMBEDDING_DIM = 256;

export type EmbedderKind = "mock" | "onnx";
