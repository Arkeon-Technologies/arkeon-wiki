// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedding worker (issue #47).
 *
 * Drains the embedding_queue: for each claimed entity, fetches the
 * chunks whose content_hash differs from the pivot's stored hash, and
 * upserts entity_embeddings + chunk_vectors for the diff. Removed
 * chunks are cleaned up at the source — syncWikiFile deletes their
 * chunk_vectors and entity_chunks rows in the same transaction (the
 * pivot cascades), so this loop only ever inserts.
 *
 * The worker is a single, in-process loop. There's no concurrency
 * within a process — Ollama calls and ONNX model invocations both want
 * a serialized batch path, and the queue's UNIQUE(entity_id) constraint
 * already coalesces concurrent edits.
 *
 * Two SQL APIs are used in tandem: createSql() for tagged-template
 * reads (chunks, pivots) and getDb()/db.prepare() for chunk_vectors
 * INSERTs. The latter is the documented workaround for sqlite-vec
 * 0.1.9's PRIMARY KEY validator, which rejects integers bound through
 * better-sqlite3's parameter path on virtual-table xUpdate. Inlining
 * the validated chunk_id as a SQL literal sidesteps the binding path.
 */

import { createSql, getDb } from "./../sql.js";
import { getEmbedder } from "./index.js";
import { EMBEDDING_DIM } from "./types.js";
import {
  claimNext,
  complete,
  fail,
  reclaimOrphans,
} from "./../embedding-queue.js";

interface ChunkRow {
  id: number;
  text: string;
  content_hash: string;
}

interface PivotRow {
  chunk_id: number;
  model: string;
  content_hash: string;
}

/**
 * Try to drain one item off the queue. Returns true if an item was
 * processed (success or failure recorded), false if the queue was
 * empty. Callers loop until `false` to fully drain.
 */
export async function drainOne(): Promise<boolean> {
  const item = await claimNext();
  if (!item) return false;

  try {
    await embedEntity(item.entity_id);
    await complete(item.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fail(item.id, msg);
    console.error(
      `[embedder] failed to embed entity ${item.entity_id}: ${msg}`,
    );
  }
  return true;
}

/**
 * Drain the queue until empty. Used by reindex CLI and tests.
 */
export async function drain(): Promise<void> {
  while (await drainOne()) {
    // tight loop; each call awaits its own embedder + DB write
  }
}

/**
 * Find chunks whose stored embedding is missing or stale (different
 * content_hash or different model), embed only those, and upsert. Also
 * purges vec0 rows for chunks that no longer exist in entity_chunks.
 *
 * Identifies stale + new chunks (by content_hash and embedder modelId)
 * and embeds + upserts pivot + vec0 in a single transaction so a
 * partial failure doesn't leave pivot/vec0 out of sync. Removed chunks
 * are cleaned up at the source by syncWikiFile, so this loop never
 * has to scan for orphans.
 */
async function embedEntity(entityId: string): Promise<void> {
  const embedder = await getEmbedder();
  if (embedder.dim !== EMBEDDING_DIM) {
    throw new Error(
      `embedder dim=${embedder.dim} doesn't match vec0 schema dim=${EMBEDDING_DIM}`,
    );
  }

  const sql = createSql();

  const chunkRows = (await sql`
    SELECT id, text, content_hash
    FROM entity_chunks
    WHERE entity_id = ${entityId}
    ORDER BY chunk_index
  `) as unknown as ChunkRow[];

  const pivotRows = (await sql`
    SELECT chunk_id, model, content_hash
    FROM entity_embeddings
    WHERE chunk_id IN (
      SELECT id FROM entity_chunks WHERE entity_id = ${entityId}
    )
  `) as unknown as PivotRow[];

  const pivotByChunk = new Map(pivotRows.map((p) => [p.chunk_id, p]));

  const toEmbed: ChunkRow[] = [];
  for (const chunk of chunkRows) {
    const pivot = pivotByChunk.get(chunk.id);
    if (
      !pivot ||
      pivot.model !== embedder.modelId ||
      pivot.content_hash !== chunk.content_hash
    ) {
      toEmbed.push(chunk);
    }
  }

  if (toEmbed.length > 0) {
    const vectors = await embedder.embed(
      toEmbed.map((c) => c.text),
      "document",
    );
    const db = getDb();

    // sqlite-vec's PRIMARY KEY validator rejects integers bound through
    // better-sqlite3's parameter path (verified empirically against
    // sqlite-vec 0.1.9 — variant test reproduced the failure for both
    // `chunk_id INTEGER PRIMARY KEY` and `rowid` columns). Inlining the
    // integer as a SQL literal is the documented workaround. chunk_id
    // comes from entity_chunks.id (INTEGER PRIMARY KEY AUTOINCREMENT)
    // so there's no injection surface — the worst a malformed value
    // could do is fail Number()-coercion below.
    const upsertPivot = db.prepare(`
      INSERT INTO entity_embeddings (chunk_id, model, content_hash)
      VALUES (?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        model = excluded.model,
        content_hash = excluded.content_hash,
        created_at = datetime('now')
    `);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < toEmbed.length; i++) {
        const chunk = toEmbed[i];
        const vec = vectors[i];
        if (vec.length !== EMBEDDING_DIM) {
          throw new Error(
            `embedder returned ${vec.length}-dim vector for chunk ${chunk.id}, expected ${EMBEDDING_DIM}`,
          );
        }
        const id = Number(chunk.id);
        if (!Number.isInteger(id)) {
          throw new Error(`chunk.id is not an integer: ${chunk.id}`);
        }
        db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id = ${id}`).run();
        db.prepare(`INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (${id}, ?)`).run(
          Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
        );
        upsertPivot.run(id, embedder.modelId, chunk.content_hash);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Background loop. Reclaims orphans on startup, then polls the queue
 * forever. Calling stop() resolves the loop on its next iteration.
 *
 * Started by the daemon's lifecycle alongside the file watcher.
 */
export interface WorkerHandle {
  stop: () => Promise<void>;
}

export function startEmbeddingWorker(opts: {
  pollIntervalMs?: number;
} = {}): WorkerHandle {
  const pollMs = opts.pollIntervalMs ?? 500;
  let running = true;
  let active: Promise<void> = Promise.resolve();

  active = (async () => {
    try {
      const reclaimed = await reclaimOrphans();
      if (reclaimed > 0) {
        console.log(`[embedder] reclaimed ${reclaimed} orphaned queue rows`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[embedder] reclaim on startup failed: ${msg}`);
    }

    while (running) {
      try {
        const drained = await drainOne();
        if (!drained) {
          await new Promise((r) => setTimeout(r, pollMs));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[embedder] worker loop error: ${msg}`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  })();

  return {
    stop: async () => {
      running = false;
      await active;
    },
  };
}
