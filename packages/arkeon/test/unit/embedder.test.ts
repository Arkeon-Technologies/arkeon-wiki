// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { MockEmbedder, EMBEDDING_DIM } from "../../src/server/lib/embedder/index.js";

describe("MockEmbedder", () => {
  it("produces vectors of the configured dimension", async () => {
    const e = new MockEmbedder();
    const [v] = await e.embed(["hello"]);
    expect(v.length).toBe(EMBEDDING_DIM);
    expect(v).toBeInstanceOf(Float32Array);
  });

  it("is deterministic across calls", async () => {
    const e = new MockEmbedder();
    const [a] = await e.embed(["the same input"]);
    const [b] = await e.embed(["the same input"]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces different vectors for different inputs", async () => {
    const e = new MockEmbedder();
    const [a] = await e.embed(["alpha"]);
    const [b] = await e.embed(["beta"]);
    let same = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    expect(same).toBe(false);
  });

  it("produces unit-length vectors (cosine-friendly)", async () => {
    const e = new MockEmbedder();
    const [v] = await e.embed(["arbitrary text"]);
    let mag = 0;
    for (const x of v) mag += x * x;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
  });

  it("batches preserve input order", async () => {
    const e = new MockEmbedder();
    const inputs = ["one", "two", "three"];
    const vectors = await e.embed(inputs);
    expect(vectors).toHaveLength(3);

    const [oneA] = await e.embed(["one"]);
    const [twoA] = await e.embed(["two"]);
    expect(Array.from(vectors[0])).toEqual(Array.from(oneA));
    expect(Array.from(vectors[1])).toEqual(Array.from(twoA));
  });

  it("identifies itself with a stable modelId", () => {
    const e = new MockEmbedder();
    expect(e.modelId).toBe("mock@256");
    expect(e.dim).toBe(EMBEDDING_DIM);
  });
});
