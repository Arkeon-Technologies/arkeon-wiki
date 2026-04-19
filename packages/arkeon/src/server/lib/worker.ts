// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Abstract base class for Arkeon background workers.
 *
 * Provides a poll loop with skip-if-running guard, lifecycle hooks,
 * and prompt building. Synchronous workers (extractor) do not extend
 * this — they read config via worker-config.ts directly.
 *
 * Pattern mirrors retention.ts: setInterval with unref so the loop
 * does not keep Node alive on its own.
 */

import type { ResolvedWorkerConfig } from "./worker-config.js";
import { buildPrompt } from "./worker-config.js";

export abstract class ArkeonWorker {
  readonly name: string;
  protected config: ResolvedWorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(name: string, config: ResolvedWorkerConfig) {
    this.name = name;
    this.config = config;
  }

  /** Called once at startup. Override for setup work. */
  async init(): Promise<void> {}

  /** Background workers implement this to poll for and process work. */
  protected abstract poll(): Promise<void>;

  /** Start the poll loop. No-op if disabled or pollIntervalMs <= 0. */
  start(): void {
    if (!this.config.enabled) {
      console.log(`[worker:${this.name}] disabled — skipping`);
      return;
    }
    if (this.config.pollIntervalMs <= 0) return;

    console.log(
      `[worker:${this.name}] started — polling every ${this.config.pollIntervalMs}ms`,
    );

    // Immediate first tick, then settle into cadence.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.poll();
    } catch (err) {
      console.error(`[worker:${this.name}]`, err);
    } finally {
      this.running = false;
    }
  }

  /** Stop the poll loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Build a system prompt by merging the built-in default with the
   * user's configured prompt text according to prompt_mode.
   */
  protected resolvePrompt(builtIn: string): string {
    return buildPrompt(builtIn, this.config.prompt);
  }
}
