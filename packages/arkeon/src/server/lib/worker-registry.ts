// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker registry — loads workers.yaml, instantiates background workers,
 * manages their lifecycle.
 *
 * The extractor is not registered here — it runs synchronously in the
 * request path and reads its config via worker-config.ts directly.
 */

import { loadWorkersYaml, resolveWorkerConfig, type WorkerName } from "./worker-config.js";
import { ArkeonWorker } from "./worker.js";
import { DraftWorker } from "./workers/draft-worker.js";

// Future workers — uncomment when implemented:
// import { ConsolidatorWorker } from "./workers/consolidator-worker.js";
// import { ConnectorWorker } from "./workers/connector-worker.js";

const workers: ArkeonWorker[] = [];

interface WorkerDef {
  name: WorkerName;
  Ctor: new (config: ReturnType<typeof resolveWorkerConfig>) => ArkeonWorker;
}

const WORKER_DEFS: WorkerDef[] = [
  { name: "drafter", Ctor: DraftWorker },
  // { name: "consolidator", Ctor: ConsolidatorWorker },
  // { name: "connector", Ctor: ConnectorWorker },
];

export async function startWorkers(): Promise<void> {
  const yamlConfig = loadWorkersYaml();

  for (const { name, Ctor } of WORKER_DEFS) {
    const config = resolveWorkerConfig(name, yamlConfig);
    const worker = new Ctor(config);
    await worker.init();
    worker.start();
    workers.push(worker);
  }
}

export function stopWorkers(): void {
  for (const w of workers) w.stop();
  workers.length = 0;
}
