// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker registry — starts and stops background workers.
 *
 * The draft, extract, and enrich workers use standalone start/stop
 * functions with module-level state (same pattern as retention.ts).
 * They gate themselves on LLM/Meilisearch availability at startup.
 */

import { startDraftWorker, stopDraftWorker } from "./workers/draft-worker.js";
import { startExtractWorker, stopExtractWorker } from "./workers/extract-worker.js";
import { startEnrichWorker, stopEnrichWorker } from "./workers/enrich-worker.js";

export async function startWorkers(): Promise<void> {
  startDraftWorker();
  startExtractWorker();
  startEnrichWorker();
}

export function stopWorkers(): void {
  stopDraftWorker();
  stopExtractWorker();
  stopEnrichWorker();
}
