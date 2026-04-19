// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Draft worker — polls wiki_draft_queue for pending placeholder entities
 * and drafts wiki content for them via LLM.
 *
 * Phase 2 stub: the poll loop is wired up and will dequeue items, but
 * the actual LLM drafting logic is not yet implemented.
 */

import { ArkeonWorker } from "../worker.js";
import type { ResolvedWorkerConfig } from "../worker-config.js";
import { withTransaction } from "../sql.js";

export class DraftWorker extends ArkeonWorker {
  constructor(config: ResolvedWorkerConfig) {
    super("drafter", config);
  }

  protected async poll(): Promise<void> {
    const batchSize = this.config.batchSize;
    const maxDepth = (this.config.extra.max_depth as number) ?? 2;

    // Claim a batch of pending items using advisory lock to prevent
    // concurrent workers from grabbing the same rows.
    const items = await withTransaction(async (tx) => {
      // Try advisory lock — skip this tick if another worker holds it
      const lockResult = await tx`SELECT pg_try_advisory_xact_lock(8675309) AS locked`;
      if (!lockResult[0]?.locked) return [];

      return tx`
        UPDATE wiki_draft_queue
        SET status = 'processing', attempts = attempts + 1
        WHERE entity_id IN (
          SELECT entity_id FROM wiki_draft_queue
          WHERE status = 'pending'
            AND depth <= ${maxDepth}
          ORDER BY created_at ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING entity_id, depth, owner_agent
      `;
    });

    if (items.length === 0) return;

    console.log(`[worker:drafter] dequeued ${items.length} item(s)`);

    for (const item of items) {
      const entityId = String(item.entity_id);
      const depth = Number(item.depth);

      try {
        await this.draftEntity(entityId, depth, String(item.owner_agent));
      } catch (err) {
        console.error(`[worker:drafter] failed to draft ${entityId}:`, (err as Error).message);
        await withTransaction(async (tx) => {
          await tx`
            UPDATE wiki_draft_queue
            SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
                error = ${(err as Error).message}
            WHERE entity_id = ${entityId}
          `;
        });
      }
    }
  }

  private async draftEntity(entityId: string, depth: number, _ownerAgent: string): Promise<void> {
    // Fetch the placeholder entity to get its label + description
    const rows = await withTransaction(async (tx) => {
      return tx`
        SELECT properties FROM entities
        WHERE id = ${entityId} AND kind = 'entity' AND type = 'placeholder'
      `;
    });

    if (rows.length === 0) {
      // Entity no longer exists or is no longer a placeholder — mark undraftable
      await withTransaction(async (tx) => {
        await tx`
          UPDATE wiki_draft_queue SET status = 'undraftable'
          WHERE entity_id = ${entityId}
        `;
      });
      return;
    }

    const props = rows[0]!.properties as Record<string, unknown>;
    const _label = String(props.label ?? "");
    const _description = String(props.description ?? "");

    // TODO(phase-2): Implement actual LLM drafting
    // 1. Build prompt using this.resolvePrompt(DRAFT_PROMPT) with entity context
    // 2. Call LLM to generate wiki content
    // 3. POST /wiki with depth+1 to create the wiki (triggers the full pipeline)
    // 4. Mark queue item as 'complete'
    //
    // For now, mark as undraftable so items don't spin forever.
    await withTransaction(async (tx) => {
      await tx`
        UPDATE wiki_draft_queue SET status = 'undraftable',
          error = 'draft worker not yet implemented'
        WHERE entity_id = ${entityId}
      `;
    });
  }
}
