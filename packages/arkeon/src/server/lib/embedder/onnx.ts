// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bundled ONNX embedder (issue #47).
 *
 * The default real embedder. Loads `embeddinggemma-300m` (q8 quantised,
 * ~309 MB) via @huggingface/transformers and runs entirely in-process
 * — no external daemon, no separate install. Weights download from the
 * HuggingFace Hub on first use to ~/.arkeon-wiki/models/ and survive
 * across restarts.
 *
 * The model is Gemma-licensed (Gemma Terms of Use, not OSI). The npm
 * package itself stays Apache-2.0 because the weights aren't bundled —
 * they're fetched by the user's machine on first launch. We surface
 * the terms with a one-time log line on the first download.
 *
 * Usage shape:
 *
 *   const e = new OnnxEmbedder();
 *   e.warmUp();              // kick off background download (non-blocking)
 *   ...
 *   await e.embed(texts, "document"); // resolves once warmUp completes
 *
 * State machine:
 *
 *   warming  ─┬─ load throws  → failed
 *             └─ load resolves → ready
 *
 * Search consumers check state() and short-circuit to {model: "warming"}
 * during the load window so the user's query doesn't hang on a 309 MB
 * download.
 */

import os from "node:os";
import path from "node:path";

import {
  env,
  AutoTokenizer,
  AutoModel,
  type PretrainedModelOptions,
  type PretrainedTokenizerOptions,
} from "@huggingface/transformers";

import {
  type Embedder,
  type EmbedKind,
  type EmbedderState,
  EMBEDDING_DIM,
} from "./types.js";

const REPO = "onnx-community/embeddinggemma-300m-ONNX";
const DTYPE = "q8" as const; // ~309 MB, model-card-blessed default
const MODEL_OUTPUT_DIM = 768;

// EmbeddingGemma's published prefixes. Skipping these silently degrades
// recall; they're part of the model's prompt-tuning contract.
const QUERY_PREFIX = "task: search result | query: ";
const DOCUMENT_PREFIX = "title: none | text: ";

interface ProgressEvent {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

function defaultCacheDir(): string {
  return (
    process.env.ARKEON_WIKI_MODELS_DIR ??
    path.join(
      process.env.ARKEON_WIKI_HOME ?? path.join(os.homedir(), ".arkeon-wiki"),
      "models",
    )
  );
}

function configureRuntime(): void {
  // Must be set BEFORE the first from_pretrained call. Idempotent —
  // calling again with the same values is a no-op.
  env.cacheDir = defaultCacheDir();
  env.allowRemoteModels = true;
  // Pin the wasm threadpool. Per @m13v's note in #47, the cold-start
  // latency on Apple Silicon was 600ms+ until threads were pinned.
  // The native ORT backend (used by default in Node) ignores wasm
  // settings, but we set both so the same code works if we ever fall
  // through to wasm.
  const threads = Math.max(1, os.cpus().length - 1);
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = threads;
  }
}

let _termsLogged = false;
function logGemmaTermsOnce(): void {
  if (_termsLogged) return;
  _termsLogged = true;
  console.log(
    "[embedder] Downloading embeddinggemma-300m (Gemma Terms of Use apply: " +
      "https://ai.google.dev/gemma/terms)",
  );
}

export class OnnxEmbedder implements Embedder {
  readonly modelId = `onnx:embeddinggemma-300m@${EMBEDDING_DIM}`;
  readonly dim = EMBEDDING_DIM;

  private _state: EmbedderState = "warming";
  private loadPromise: Promise<void> | null = null;
  private tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
  private model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;
  private loadError: Error | null = null;

  state(): EmbedderState {
    return this._state;
  }

  warmUp(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.load();
    // Swallow rejection at the top level — embed() will surface it
    // with full context. We just don't want an unhandled rejection
    // bubbling out of a fire-and-forget warmUp().
    this.loadPromise.catch(() => {});
    return this.loadPromise;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;

    if (this._state !== "ready" || !this.tokenizer || !this.model) {
      throw new Error(
        `OnnxEmbedder is in state=${this._state}` +
          (this.loadError ? `: ${this.loadError.message}` : ""),
      );
    }

    const prefix = kind === "query" ? QUERY_PREFIX : DOCUMENT_PREFIX;
    const prefixed = texts.map((t) => prefix + t);

    // Tokenize the whole batch.
    const inputs = await this.tokenizer(prefixed, {
      padding: true,
      truncation: true,
    });

    const out = await this.model(inputs);
    const tensor = out.sentence_embedding;
    if (!tensor || !tensor.data || !tensor.dims) {
      throw new Error("ONNX model did not return a sentence_embedding tensor");
    }

    const [batch, fullDim] = tensor.dims;
    if (fullDim !== MODEL_OUTPUT_DIM) {
      throw new Error(
        `Expected sentence_embedding dim=${MODEL_OUTPUT_DIM}, got ${fullDim}. ` +
          `The repo or dtype may have changed.`,
      );
    }
    if (batch !== texts.length) {
      throw new Error(
        `Expected batch=${texts.length}, got ${batch}`,
      );
    }

    const data = tensor.data as Float32Array;
    const result: Float32Array[] = [];
    for (let b = 0; b < batch; b++) {
      // Slice to the first EMBEDDING_DIM dims (Matryoshka truncation —
      // the model is trained so the leading prefix of the 768d vector
      // is itself a usable embedding at 256d).
      const sliced = new Float32Array(EMBEDDING_DIM);
      const offset = b * fullDim;
      for (let i = 0; i < EMBEDDING_DIM; i++) sliced[i] = data[offset + i];

      // L2-renormalise so cosine distance is well-defined.
      let mag = 0;
      for (const v of sliced) mag += v * v;
      mag = Math.sqrt(mag);
      if (mag > 0) {
        for (let i = 0; i < sliced.length; i++) sliced[i] /= mag;
      }
      result.push(sliced);
    }
    return result;
  }

  private async load(): Promise<void> {
    configureRuntime();

    const onProgress = (p: ProgressEvent): void => {
      if (p.status === "progress" && typeof p.progress === "number" && p.file) {
        // Throttled-ish via the progress events themselves (one per
        // chunk). This is what the user sees while the download runs.
        const mb = p.loaded != null && p.total != null
          ? ` ${(p.loaded / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)} MB`
          : "";
        process.stderr.write(
          `\r[embedder] ${p.file} ${p.progress.toFixed(0)}%${mb}      `,
        );
      } else if (p.status === "done" && p.file) {
        process.stderr.write(`\n[embedder] ✓ ${p.file}\n`);
      }
    };

    try {
      logGemmaTermsOnce();

      const tokenizerOpts: PretrainedTokenizerOptions = {
        progress_callback: onProgress,
      };
      const modelOpts: PretrainedModelOptions = {
        dtype: DTYPE,
        progress_callback: onProgress,
      };

      const t0 = Date.now();
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(REPO, tokenizerOpts),
        AutoModel.from_pretrained(REPO, modelOpts),
      ]);

      this.tokenizer = tokenizer;
      this.model = model;
      this._state = "ready";
      console.log(
        `[embedder] ready (${this.modelId}, loaded in ${Date.now() - t0}ms, ` +
          `cache=${env.cacheDir})`,
      );
    } catch (err) {
      this._state = "failed";
      this.loadError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[embedder] failed to load ${REPO} (${DTYPE}): ${this.loadError.message}. ` +
          `Vector search will return {model: "unavailable"} until this is fixed. ` +
          `Try restarting the daemon once any network/disk issue is resolved.`,
      );
      throw this.loadError;
    }
  }
}
