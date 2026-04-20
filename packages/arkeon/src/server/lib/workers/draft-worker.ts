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
 * Follows the retention.ts start/stop pattern with setInterval.
 */

import type { Actor } from "../../types.js";
import { findSimilarEntities, type EntityMatch } from "../entity-resolve.js";
import { gatherDossier, type PlaceholderInfo } from "./draft-gather.js";
import { generateDraft } from "./draft-prompt.js";
import { isLlmConfigured } from "../llm.js";
import { isMeilisearchConfigured } from "../meilisearch.js";
import { withTransaction } from "../sql.js";
import { setActorContext, withSystemActorContext } from "../actor-context.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;

const POLL_MS = Number(process.env.DRAFT_WORKER_POLL_MS) || 10_000;

// ---------------------------------------------------------------------------
// Queue operations (run as system actor — the queue is not user-facing)
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
// Actor + placeholder loading
// ---------------------------------------------------------------------------

async function loadActor(actorId: string): Promise<Actor | null> {
  return withSystemActorContext(async (sql) => {
    const rows = await sql`
      SELECT id, properties
      FROM actors WHERE id = ${actorId} LIMIT 1
    `;
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    const props = (row.properties as Record<string, unknown>) ?? {};
    return {
      id: String(row.id),
      apiKeyId: "",
      keyPrefix: "",
      label: typeof props.label === "string" ? props.label : null,
    };
  });
}

async function loadPlaceholder(entityId: string, actor: Actor): Promise<PlaceholderInfo | null> {
  return withTransaction(async (sql) => {
    for (const q of setActorContext(sql, actor)) await q;

    const rows = await sql`
      SELECT e.id, e.type, e.properties,
        (SELECT se.space_id FROM space_entities se WHERE se.entity_id = e.id LIMIT 1) AS space_id
      FROM entities e
      WHERE e.id = ${entityId} AND e.kind = 'entity'
      LIMIT 1
    `;
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    const props = (row.properties as Record<string, unknown>) ?? {};
    return {
      id: String(row.id),
      label: String(props.label ?? ""),
      description: typeof props.description === "string" ? props.description : null,
      spaceId: String(row.space_id ?? ""),
    };
  });
}

// ---------------------------------------------------------------------------
// Redirect helper
// ---------------------------------------------------------------------------

async function redirectPlaceholder(placeholderId: string, targetWikiId: string, actorId: string): Promise<void> {
  await withSystemActorContext(async (sql) => {
    await sql`
      INSERT INTO entity_redirects (old_id, new_id, merged_at, merged_by)
      VALUES (${placeholderId}, ${targetWikiId}, NOW(), ${actorId})
      ON CONFLICT (old_id) DO NOTHING
    `;
  });
}

// ---------------------------------------------------------------------------
// Submit draft via HTTP to the local API
// ---------------------------------------------------------------------------

async function submitDraft(
  draft: { label: string; keywords: string[]; short_description: string; content: string; aliases?: string[]; subject_type?: string },
  spaceId: string,
  depth: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const port = process.env.PORT ?? "8000";
  const adminKey = process.env.ADMIN_BOOTSTRAP_KEY;
  if (!adminKey) throw new Error("ADMIN_BOOTSTRAP_KEY not set — cannot submit draft");

  const payload: Record<string, unknown> = {
    content: draft.content,
    label: draft.label,
    keywords: draft.keywords,
    short_description: draft.short_description,
    space_id: spaceId,
    depth,
  };
  if (draft.aliases && draft.aliases.length > 0) payload.aliases = draft.aliases;
  if (draft.subject_type) payload.type = draft.subject_type;

  const res = await fetch(`http://localhost:${port}/wiki`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": adminKey,
    },
    body: JSON.stringify(payload),
  });

  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Core: process one queue item
// ---------------------------------------------------------------------------

async function processItem(row: QueueRow): Promise<void> {
  const tag = `[draft-worker] ${row.entity_id.slice(0, 8)}`;

  // Load the actor who requested the draft
  const actor = await loadActor(row.owner_agent);
  if (!actor) {
    console.warn(`${tag} owner_agent ${row.owner_agent} not found, marking failed`);
    await markFailed(row.entity_id, `owner_agent ${row.owner_agent} not found`, row.attempts, row.max_attempts);
    return;
  }

  // Load the placeholder entity
  const placeholder = await loadPlaceholder(row.entity_id, actor);
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

  // --- Step 1: Reconcile — does a wiki already cover this subject? ---
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
      await redirectPlaceholder(placeholder.id, match.id, actor.id);
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
    // Update the placeholder entity's status to undraftable
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

  const { status, body } = await submitDraft(draft, placeholder.spaceId, row.depth);

  if (status === 201) {
    const wikiId = String((body.wiki as Record<string, unknown>)?.id ?? "");
    console.log(`${tag} published wiki ${wikiId}`);
    // Redirect the placeholder to the newly drafted wiki so that
    // [[entity:<placeholder>]] links in the parent wiki resolve to it.
    if (wikiId) {
      await redirectPlaceholder(placeholder.id, wikiId, actor.id);
    }
    await markComplete(row.entity_id, { resultWikiId: wikiId, dossier });
    return;
  }

  if (status === 409) {
    // Wiki with this label already exists — redirect to it
    const existingId = String(
      ((body.error as Record<string, unknown>)?.details as Record<string, unknown>)?.existing_wiki_id ?? "",
    );
    if (existingId) {
      console.log(`${tag} wiki already exists (${existingId}), redirecting`);
      await redirectPlaceholder(placeholder.id, existingId, actor.id);
      await markComplete(row.entity_id, { mergedInto: existingId, dossier });
    } else {
      await markFailed(row.entity_id, `409 wiki_exists but no existing_wiki_id in response`, row.attempts, row.max_attempts);
    }
    return;
  }

  // Other errors: retry or fail
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

  // Recover any rows stuck in 'processing' from a previous crash
  void recoverStuckRows().then((n) => {
    if (n > 0) console.log(`[draft-worker] recovered ${n} stuck row(s)`);
  });

  console.log(`[draft-worker] started (poll=${POLL_MS}ms)`);
  void tick(); // immediate first tick
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
