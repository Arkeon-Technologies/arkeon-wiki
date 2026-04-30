// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic mock embedder for tests and graceful fallback.
 *
 * Builds a 256-dim unit vector by hashing the input text into a
 * sha256 digest, expanding it to fill the dimension, and L2-normalising
 * so cosine distance is well-defined. Same text → same vector across
 * runs and platforms. Not semantically meaningful — only useful to
 * exercise the pipeline (write, store, look up) without pulling 200 MB
 * of real weights into CI.
 */

import { createHash } from "node:crypto";
import { type Embedder, EMBEDDING_DIM } from "./types.js";

export class MockEmbedder implements Embedder {
  readonly modelId = "mock@256";
  readonly dim = EMBEDDING_DIM;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => mockVector(text, this.dim));
  }
}

function mockVector(text: string, dim: number): Float32Array {
  // Stretch the 32-byte sha256 across `dim` floats by re-hashing with
  // a counter until we have enough material. Each byte → one float.
  const out = new Float32Array(dim);
  let written = 0;
  let counter = 0;
  while (written < dim) {
    const buf = createHash("sha256").update(`${counter}\n${text}`).digest();
    for (let i = 0; i < buf.length && written < dim; i++) {
      // Map [0, 255] → [-1, 1]
      out[written++] = (buf[i] - 127.5) / 127.5;
    }
    counter++;
  }

  // L2-normalise so cosine distance behaves.
  let mag = 0;
  for (const v of out) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= mag;
  }
  return out;
}
