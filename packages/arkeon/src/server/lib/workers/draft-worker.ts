// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiki draft worker — polls wiki_draft_queue and drafts wiki pages.
 *
 * For each pending placeholder:
 *   1. Reconcile: check if a published wiki already covers this subject.
 *      If so, redirect the placeholder and skip drafting.
 *   2. Gather: run a read-only agent loop to build a context dossier.
 *   3. Draft: call the drafting LLM to produce a wiki page.
 *   4. Submit: POST the draft to /wiki (existing pipeline handles
 *      resolve, relationships, and publishing).
 *
 * Reads go through the internal API client to prevent schema drift.
 * Queue operations stay as raw SQL (FOR UPDATE SKIP LOCKED atomicity).
 */

import { findSimilarEntities, type EntityMatch } from "../entity-resolve.js";
import { gatherDossier, type PlaceholderInfo } from "./draft-gather.js";
import { generateDraft } from "./draft-prompt.js";
import { isLlmConfigured } from "../llm.js";
import { isMeilisearchConfigured } from "../meilisearch.js";
import { withSystemActorContext } from "../actor-context.js";
import * as api from "./internal-api.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;

const POLL_MS = Number(process.env.DRAFT_WORKER_POLL_MS) || 10_000;

// ---------------------------------------------------------------------------
// Queue operations (raw SQL — needs FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------

interface QueueRow {
  entity_id: string;
  depth: number;
  owner_agent: string;
  attempts: number;
  max_attempts: number;
}

async function claimNext(): Promise<QueueRow | null> {
  return withSystemActorContext(async (sql) => {
    const rows = await sql.query(
      `UPDATE wiki_draft_queue
       SET status = 'processing',
           attempts = attempts + 1,
           started_at = NOW()
       WHERE entity_id = (
         SELECT entity_id FROM wiki_draft_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING entity_id, depth, owner_agent, attempts, max_attempts`,
      [],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    return {
      entity_id: String(row.entity_id),
      depth: Number(row.depth),
      owner_agent: String(row.owner_agent),
      attempts: Number(row.attempts),
      max_attempts: Number(row.max_attempts),
    };
  });
}

async function markComplete(
  entityId: string,
  result?: { resultWikiId?: string; mergedInto?: string; dossier?: unknown },
): Promise<void> {
  await withSystemActorContext(async (sql) => {
    await sql.query(
      `UPDATE wiki_draft_queue
       SET status = 'complete',
           result_wiki_id = $2,
           merged_into = $3,
           context_dossier = $4::jsonb
       WHERE entity_id = $1`,
      [
        entityId,
        result?.resultWikiId ?? null,
        result?.mergedInto ?? null,
        result?.dossier ? JSON.stringify(result.dossier) : null,
      ],
    );
  });
}

async function markFailed(entityId: string, error: string, attempts: number, maxAttempts: number): Promise<void> {
  const status = attempts >= maxAttempts ? "failed" : "pending";
  await withSystemActorContext(async (sql) => {
    await sql.query(
      `UPDATE wiki_draft_queue SET status = $2, error = $3 WHERE entity_id = $1`,
      [entityId, status, error.slice(0, 500)],
    );
  });
}

async function markUndraftable(entityId: string, reason: string, dossier?: unknown): Promise<void> {
  await withSystemActorContext(async (sql) => {
    await sql.query(
      `UPDATE wiki_draft_queue
       SET status = 'undraftable',
           error = $2,
           context_dossier = $3::jsonb
       WHERE entity_id = $1`,
      [entityId, reason.slice(0, 500), dossier ? JSON.stringify(dossier) : null],
    );
  });
}

async function recoverStuckRows(): Promise<number> {
  return withSystemActorContext(async (sql) => {
    const rows = await sql`
      UPDATE wiki_draft_queue
      SET status = 'pending'
      WHERE status = 'processing'
        AND attempts < max_attempts
      RETURNING entity_id
    `;
    return (rows as unknown[]).length;
  });
}

// ---------------------------------------------------------------------------
// Placeholder loading via API
// ---------------------------------------------------------------------------

async function loadPlaceholder(entityId: string): Promise<PlaceholderInfo | null> {
  const entity = await api.getWikiEntity(entityId, "full");
  if (!entity) return null;
  const props = entity.properties;
  return {
    id: entity.id,
    label: String(props.label ?? ""),
    description: typeof props.description === "string" ? props.description : null,
    spaceId: entity.space_ids?.[0] ?? "",
    subjectType: typeof props.subject_type === "string" ? props.subject_type : null,
  };
}

// ---------------------------------------------------------------------------
// Core: process one queue item
// ---------------------------------------------------------------------------

async function processItem(row: QueueRow): Promise<void> {
  const tag = `[draft-worker] ${row.entity_id.slice(0, 8)}`;

  // Load the actor who requested the draft via API
  const actor = await api.getActor(row.owner_agent);
  if (!actor) {
    console.warn(`${tag} owner_agent ${row.owner_agent} not found, marking failed`);
    await markFailed(row.entity_id, `owner_agent ${row.owner_agent} not found`, row.attempts, row.max_attempts);
    return;
  }

  // Load the placeholder entity via API
  const placeholder = await loadPlaceholder(row.entity_id);
  if (!placeholder) {
    console.log(`${tag} placeholder entity gone, marking complete`);
    await markComplete(row.entity_id);
    return;
  }
  if (!placeholder.spaceId) {
    await markFailed(row.entity_id, "placeholder has no space", row.attempts, row.max_attempts);
    return;
  }

  console.log(`${tag} processing "${placeholder.label}" (depth=${row.depth}, attempt=${row.attempts})`);

  // --- Step 1: Reconcile — does a published wiki already cover this subject? ---
  // Only check wikis, not other placeholders. If no wiki exists, the first
  // placeholder through drafts one. Subsequent duplicates find that wiki and
  // merge into it, preserving the original wiki's content.
  let reconcileCandidates: EntityMatch[] = [];
  try {
    reconcileCandidates = await findSimilarEntities(
      { label: placeholder.label, description: placeholder.description ?? undefined },
      {
        actor,
        spaceId: placeholder.spaceId,
        candidateFilter: ['type = "wiki"'],
        llmStep: "exists",
      },
    );

    if (reconcileCandidates.length > 0 && reconcileCandidates[0]!.confidence >= 0.8) {
      const match = reconcileCandidates[0]!;
      console.log(`${tag} reconcile match: ${match.id} (confidence=${match.confidence})`);
      // Merge transfers relationships from this placeholder to the wiki,
      // creates a redirect, and deletes the placeholder.
      const target = await api.getWikiEntity(match.id);
      if (target) {
        const { status, body: mergeBody } = await api.postMerge(target.id, placeholder.id, target.ver);
        if (status === 200) {
          console.log(`${tag} merged into ${target.id}`);
          await markComplete(row.entity_id, { mergedInto: target.id });
          return;
        }
        console.warn(`${tag} merge returned ${status}, falling back to redirect:`, JSON.stringify(mergeBody).slice(0, 300));
      }
      await api.postRedirect(placeholder.id, match.id);
      await markComplete(row.entity_id, { mergedInto: match.id });
      return;
    }
  } catch (err) {
    console.warn(`${tag} reconcile failed, continuing to draft:`, (err as Error).message);
  }

  // --- Step 2: Gather context ---
  const dossier = await gatherDossier(placeholder, actor, row.depth, reconcileCandidates);
  console.log(
    `${tag} gather complete: ${dossier.inboundSpans.length} spans, ` +
    `${dossier.confidentEntityLinks.length} entities, ` +
    `${dossier.usage.turns} turns`,
  );

  // --- Step 3: Draft ---
  const { draft, usage: draftUsage } = await generateDraft(placeholder, dossier, row.depth);

  if (!draft.can_draft) {
    console.log(`${tag} undraftable: ${draft.refused_reason}`);
    await markUndraftable(row.entity_id, draft.refused_reason ?? "LLM declined to draft", dossier);
    // Best-effort status update on the placeholder entity (stays as raw SQL)
    try {
      await withSystemActorContext(async (sql) => {
        await sql`
          UPDATE entities
          SET properties = properties || '{"status": "undraftable"}'::jsonb
          WHERE id = ${row.entity_id}
        `;
      });
    } catch { /* best effort */ }
    return;
  }

  // --- Step 4: Submit via POST /wiki ---
  console.log(
    `${tag} submitting draft "${draft.label}" (${draft.content.length} chars, ` +
    `gather=${dossier.usage.tokensIn + dossier.usage.tokensOut}tok, ` +
    `draft=${draftUsage.tokensIn + draftUsage.tokensOut}tok)`,
  );

  const payload: Parameters<typeof api.postWiki>[0] = {
    content: draft.content,
    label: draft.label,
    keywords: draft.keywords,
    short_description: draft.short_description,
    space_id: placeholder.spaceId,
    depth: row.depth,
  };
  if (draft.aliases && draft.aliases.length > 0) payload.aliases = draft.aliases;
  const subjectType = draft.subject_type || placeholder.subjectType;
  if (subjectType) payload.subject_type = subjectType;

  const { status, body } = await api.postWiki(payload);

  if (status === 201) {
    const wikiId = String((body.wiki as Record<string, unknown>)?.id ?? "");
    console.log(`${tag} published wiki ${wikiId}`);
    if (wikiId) {
      await api.postRedirect(placeholder.id, wikiId);
    }
    await markComplete(row.entity_id, { resultWikiId: wikiId, dossier });
    return;
  }

  if (status === 409) {
    const existingId = String(
      ((body.error as Record<string, unknown>)?.details as Record<string, unknown>)?.existing_wiki_id ?? "",
    );
    if (existingId) {
      console.log(`${tag} wiki already exists (${existingId}), redirecting`);
      await api.postRedirect(placeholder.id, existingId);
      await markComplete(row.entity_id, { mergedInto: existingId, dossier });
    } else {
      await markFailed(row.entity_id, `409 wiki_exists but no existing_wiki_id in response`, row.attempts, row.max_attempts);
    }
    return;
  }

  const errMsg = JSON.stringify(body).slice(0, 400);
  console.warn(`${tag} POST /wiki returned ${status}: ${errMsg}`);
  await markFailed(row.entity_id, `POST /wiki ${status}: ${errMsg}`, row.attempts, row.max_attempts);
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const row = await claimNext();
    if (!row) return;

    try {
      await processItem(row);
    } catch (err) {
      console.error(`[draft-worker] ${row.entity_id.slice(0, 8)} unexpected error:`, err);
      await markFailed(
        row.entity_id,
        `Unexpected: ${(err as Error).message}`,
        row.attempts,
        row.max_attempts,
      ).catch(() => {});
    }
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startDraftWorker(): void {
  if (timer) return;
  if (!isLlmConfigured()) {
    console.warn("[draft-worker] LLM not configured — draft worker disabled");
    return;
  }
  if (!isMeilisearchConfigured()) {
    console.warn("[draft-worker] Meilisearch not configured — draft worker disabled");
    return;
  }

  void recoverStuckRows().then((n) => {
    if (n > 0) console.log(`[draft-worker] recovered ${n} stuck row(s)`);
  });

  console.log(`[draft-worker] started (poll=${POLL_MS}ms)`);
  void tick();
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
}

export function stopDraftWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[draft-worker] stopped");
  }
}
