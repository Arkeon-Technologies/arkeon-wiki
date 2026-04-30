// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ollama embedder (issue #47).
 *
 * Talks to a locally-running Ollama daemon via its HTTP API. Used when:
 *   - The user has Ollama installed and the embeddinggemma model pulled.
 *   - Forced via ARKEON_WIKI_EMBEDDER=ollama.
 *
 * `tryOllama()` is the auto-detect path: it returns a configured
 * embedder if both the daemon is reachable and the model is present,
 * else null. We never auto-pull — pulling 200 MB without warning isn't
 * okay. The user must `ollama pull embeddinggemma:300m` first.
 *
 * Customise host/port/model via:
 *   ARKEON_WIKI_OLLAMA_URL=http://localhost:11434
 *   ARKEON_WIKI_OLLAMA_MODEL=embeddinggemma:300m
 */

import { type Embedder, EMBEDDING_DIM } from "./types.js";

const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "embeddinggemma:300m";

interface OllamaEmbedResponse {
  embeddings: number[][];
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

class OllamaEmbedder implements Embedder {
  readonly modelId: string;
  readonly dim = EMBEDDING_DIM;

  constructor(
    private readonly url: string,
    private readonly model: string,
  ) {
    this.modelId = `ollama:${model}@${EMBEDDING_DIM}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        // EmbeddingGemma supports Matryoshka — request 256d explicitly so
        // we don't waste bytes round-tripping the full 768d.
        options: { dimensions: EMBEDDING_DIM },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ollama embed failed (${res.status} ${res.statusText}): ${body.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as OllamaEmbedResponse;
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama returned ${json.embeddings?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }

    return json.embeddings.map((v) => {
      if (v.length !== EMBEDDING_DIM) {
        throw new Error(
          `Ollama returned ${v.length}-dim vector, expected ${EMBEDDING_DIM}. ` +
            `If your model doesn't support Matryoshka truncation, swap to embeddinggemma:300m.`,
        );
      }
      return new Float32Array(v);
    });
  }
}

export function createOllamaEmbedder(): Embedder {
  const url = process.env.ARKEON_WIKI_OLLAMA_URL ?? DEFAULT_URL;
  const model = process.env.ARKEON_WIKI_OLLAMA_MODEL ?? DEFAULT_MODEL;
  return new OllamaEmbedder(url, model);
}

/**
 * Auto-detect helper. Returns an embedder if Ollama is reachable AND
 * the configured model is present locally. Returns null otherwise —
 * never throws — so the resolver can cleanly fall through to the next
 * backend.
 */
export async function tryOllama(): Promise<Embedder | null> {
  const url = process.env.ARKEON_WIKI_OLLAMA_URL ?? DEFAULT_URL;
  const model = process.env.ARKEON_WIKI_OLLAMA_MODEL ?? DEFAULT_MODEL;

  let tags: OllamaTagsResponse;
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    tags = (await res.json()) as OllamaTagsResponse;
  } catch {
    return null;
  }

  const models = tags.models ?? [];
  const present = models.some(
    (m) => m.name === model || m.model === model,
  );
  if (!present) return null;

  return new OllamaEmbedder(url, model);
}
