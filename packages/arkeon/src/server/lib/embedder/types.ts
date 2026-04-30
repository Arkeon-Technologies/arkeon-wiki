// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedder types and shared constants. Lives in its own module so
 * concrete backends (mock, ollama, future onnx) can import without
 * pulling in the resolver and creating a cycle.
 */

export interface Embedder {
  /** Stable identifier of the model+dim pair, e.g. "embeddinggemma-300m@256". */
  readonly modelId: string;
  /** Vector dimensionality. Asserted to match the vec0 schema (256). */
  readonly dim: number;
  /** Embed a batch. Returned vectors are length === dim. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Vec0 column dimension. Don't change without a schema migration. */
export const EMBEDDING_DIM = 256;

export type EmbedderKind = "mock" | "ollama";
