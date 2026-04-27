// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-agnostic model selection for the agent runtime.
 *
 * Three providers cover everything we care about today:
 *   - "anthropic"          @ai-sdk/anthropic, native (Claude + caching)
 *   - "openai"             @ai-sdk/openai, official OpenAI endpoint
 *   - "openai-compatible"  @ai-sdk/openai with custom baseURL — covers
 *                          Ollama (http://localhost:11434/v1), LM Studio,
 *                          llama.cpp's --server, vLLM, OpenRouter, Groq,
 *                          Together, and anything else that speaks
 *                          OpenAI's chat/completions shape.
 *
 * Roles take a ModelConfig; resolveModel returns the AI SDK
 * LanguageModel they hand to generateText. Swapping cloud-Anthropic for
 * local-Ollama is a config change, not a code change.
 */

import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

export type ModelConfig =
  | { provider: "anthropic"; id: string; apiKey?: string }
  | { provider: "openai"; id: string; apiKey?: string }
  | {
      provider: "openai-compatible";
      id: string;
      baseURL: string;
      apiKey?: string;
    };

export function resolveModel(config: ModelConfig): LanguageModel {
  switch (config.provider) {
    case "anthropic": {
      const provider = createAnthropic({ apiKey: config.apiKey });
      return provider(config.id);
    }
    case "openai": {
      const provider = createOpenAI({ apiKey: config.apiKey });
      return provider(config.id);
    }
    case "openai-compatible": {
      // Local servers (Ollama, LM Studio, etc.) typically don't require
      // a real key but the SDK demands the field be present.
      const provider = createOpenAI({
        baseURL: config.baseURL,
        apiKey: config.apiKey ?? "not-required",
      });
      return provider(config.id);
    }
  }
}
