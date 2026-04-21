// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiki enrich worker — polls wiki_enrich_queue and enriches existing
 * wiki articles with new source material.
 *
 * For each pending enrichment job:
 *   1. Load the existing wiki (current content + ver).
 *   2. Load the new source document.
 *   3. Collect labels of already-incorporated sources.
 *   4. Call the enrichment LLM to produce updated content.
 *   5. Submit via PUT /wiki/{id} (optimistic concurrency).
 *   6. Create an extracted_from relationship to track enrichment.
 *
 * Reads go through the internal API client to prevent schema drift.
 * Queue operations stay as raw SQL (FOR UPDATE SKIP LOCKED atomicity).
 */

import { generateEnrichment, type EnrichContext } from "./enrich-prompt.js";
import { isLlmConfigured } from "../llm.js";
import { generateUlid } from "../ids.js";
import { withSystemActorContext } from "../actor-context.js";
import * as api from "./internal-api.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;

const POLL_MS = Number(process.env.ENRICH_WORKER_POLL_MS) || 10_000;

// ---------------------------------------------------------------------------
// Queue operations (raw SQL — needs FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  target_wiki_id: string;
  source_id: string;
  space_id: string;
  owner_agent: string;
  attempts: number;
  max_attempts: number;
}

async function claimNext(): Promise<QueueRow | null> {
  return withSystemActorContext(async (sql) => {
    const rows = await sql.query(
      `UPDATE wiki_enrich_queue
       SET status = 'processing',
           attempts = attempts + 1,
           started_at = NOW()
       WHERE id = (
         SELECT id FROM wiki_enrich_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, target_wiki_id, source_id, space_id, owner_agent, attempts, max_attempts`,
      [],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    return {
      id: String(row.id),
      target_wiki_id: String(row.target_wiki_id),
      source_id: String(row.source_id),
      space_id: String(row.space_id),
      owner_agent: String(row.owner_agent),
      attempts: Number(row.attempts),
      max_attempts: Number(row.max_attempts),
    };
  });
}

async function markComplete(id: string): Promise<void> {
  await withSystemActorContext(async (sql) => {
    await sql.query(
      `UPDATE wiki_enrich_queue SET status = 'complete' WHERE id = $1`,
      [id],
    );
  });
}

async function markFailed(id: string, error: string, attempts: number, maxAttempts: number): Promise<void> {
  const status = attempts >= maxAttempts ? "failed" : "pending";
  await withSystemActorContext(async (sql) => {
    await sql.query(
      `UPDATE wiki_enrich_queue SET status = $2, error = $3 WHERE id = $1`,
      [id, status, error.slice(0, 500)],
    );
  });
}

async function recoverStuckRows(): Promise<number> {
  return withSystemActorContext(async (sql) => {
    const rows = await sql`
      UPDATE wiki_enrich_queue
      SET status = 'pending'
      WHERE status = 'processing'
        AND attempts < max_attempts
      RETURNING id
    `;
    return (rows as unknown[]).length;
  });
}

// ---------------------------------------------------------------------------
// Core: process one enrichment job
// ---------------------------------------------------------------------------

async function processItem(row: QueueRow): Promise<void> {
  const tag = `[enrich-worker] ${row.id.slice(0, 8)}`;

  // Load the existing wiki
  const wiki = await api.getWikiEntity(row.target_wiki_id, "full");
  if (!wiki) {
    console.log(`${tag} wiki ${row.target_wiki_id.slice(0, 8)} gone, marking complete`);
    await markComplete(row.id);
    return;
  }

  // Load the source document
  const source = await api.getFile(row.source_id);
  if (!source) {
    console.log(`${tag} source ${row.source_id.slice(0, 8)} gone, marking complete`);
    await markComplete(row.id);
    return;
  }

  const wikiProps = wiki.properties;
  const sourceProps = source.properties;
  const wikiContent = typeof wikiProps.content === "string" ? wikiProps.content : "";
  const sourceContent = typeof sourceProps.content === "string" ? sourceProps.content : "";

  if (!wikiContent) {
    console.log(`${tag} wiki has no content, marking complete`);
    await markComplete(row.id);
    return;
  }
  if (!sourceContent) {
    console.log(`${tag} source has no content, marking complete`);
    await markComplete(row.id);
    return;
  }

  // Collect already-incorporated sources (via extracted_from relationships)
  const rels = await api.getRelationships(row.target_wiki_id, {
    direction: "out",
    predicate: "extracted_from",
  });
  const incorporatedSources = rels
    .map((r) => {
      const targetProps = r.target?.properties;
      return typeof targetProps?.label === "string" ? targetProps.label : null;
    })
    .filter((label): label is string => label !== null);

  console.log(
    `${tag} enriching "${wikiProps.label}" (ver=${wiki.ver}) ` +
    `with "${sourceProps.label}" (${sourceContent.length} chars, ${incorporatedSources.length} prior sources)`,
  );

  // Build context and call LLM
  const ctx: EnrichContext = {
    wiki: {
      label: typeof wikiProps.label === "string" ? wikiProps.label : "",
      content: wikiContent,
      keywords: Array.isArray(wikiProps.keywords) ? wikiProps.keywords.filter((k): k is string => typeof k === "string") : [],
      short_description: typeof wikiProps.short_description === "string" ? wikiProps.short_description : "",
      ver: wiki.ver,
    },
    source: {
      label: typeof sourceProps.label === "string" ? sourceProps.label : "",
      content: sourceContent,
    },
    incorporatedSources,
  };

  const { response: enrichResult, usage } = await generateEnrichment(ctx);

  console.log(
    `${tag} LLM complete: enriched=${enrichResult.enriched} ` +
    `reason=${enrichResult.reason ?? "n/a"} ` +
    `content_len=${enrichResult.content.length} ` +
    `(${usage.tokensIn + usage.tokensOut}tok)`,
  );

  if (!enrichResult.enriched) {
    console.log(`${tag} no meaningful enrichment: ${enrichResult.reason}`);
    await markComplete(row.id);
    return;
  }

  // Submit update via PUT /wiki/{id}
  const updateProps: Record<string, unknown> = {
    content: enrichResult.content,
  };
  if (enrichResult.keywords.length > 0) {
    updateProps.keywords = enrichResult.keywords;
  }
  if (enrichResult.short_description) {
    updateProps.short_description = enrichResult.short_description;
  }

  const sourceLabel = typeof sourceProps.label === "string" ? sourceProps.label : row.source_id.slice(0, 8);
  const { status, body } = await api.putWiki(row.target_wiki_id, {
    ver: wiki.ver,
    properties: updateProps,
    note: `Enriched from "${sourceLabel}"`,
  });

  if (status === 200) {
    console.log(`${tag} wiki updated successfully`);
  } else if (status === 409) {
    // Version conflict — another enrichment or edit got there first.
    // Retry by resetting to pending (the next tick will re-process with fresh ver).
    console.log(`${tag} version conflict (409), will retry`);
    await markFailed(row.id, "Version conflict — wiki was modified concurrently", row.attempts, row.max_attempts);
    return;
  } else {
    const errMsg = JSON.stringify(body).slice(0, 400);
    console.warn(`${tag} PUT /wiki/${row.target_wiki_id} returned ${status}: ${errMsg}`);
    await markFailed(row.id, `PUT /wiki ${status}: ${errMsg}`, row.attempts, row.max_attempts);
    return;
  }

  // Create extracted_from relationship to track that this source was incorporated.
  // This uses the internal API's post helper to call POST /wiki/{id}/relationships.
  // We go through raw SQL here because the relationship creation API creates
  // relationship entities (which require the full entity pipeline). Instead,
  // we insert the edge directly — same pattern used in the placeholder route.
  try {
    await withSystemActorContext(async (sql) => {
      // Check if relationship already exists
      const existing = await sql.query(
        `SELECT re.id FROM relationship_edges re
         JOIN entities e ON e.id = re.id
         WHERE re.source_id = $1 AND re.target_id = $2 AND e.type = 'extracted_from'
         LIMIT 1`,
        [row.target_wiki_id, row.source_id],
      );
      if ((existing as unknown[]).length > 0) return;

      // Create the relationship entity + edge
      const relId = generateUlid();
      const now = new Date().toISOString();
      await sql.query(
        `INSERT INTO entities (id, kind, type, ver, properties, owner_id, edited_by, created_at, updated_at)
         VALUES ($1, 'relationship', 'extracted_from', 1, $2::jsonb, $3, $3, $4::timestamptz, $4::timestamptz)`,
        [relId, JSON.stringify({ detail: `Enriched from "${sourceLabel}"` }), row.owner_agent, now],
      );
      await sql.query(
        `INSERT INTO relationship_edges (id, source_id, target_id, predicate)
         VALUES ($1, $2, $3, 'extracted_from')`,
        [relId, row.target_wiki_id, row.source_id],
      );
    });
  } catch (err) {
    // Best-effort — the enrichment itself succeeded, don't fail the job
    console.warn(`${tag} failed to create extracted_from relationship:`, (err as Error).message);
  }

  await markComplete(row.id);
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
      console.error(`[enrich-worker] ${row.id.slice(0, 8)} unexpected error:`, err);
      await markFailed(
        row.id,
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

export function startEnrichWorker(): void {
  if (timer) return;
  if (!isLlmConfigured()) {
    console.warn("[enrich-worker] LLM not configured — enrich worker disabled");
    return;
  }

  void recoverStuckRows().then((n) => {
    if (n > 0) console.log(`[enrich-worker] recovered ${n} stuck row(s)`);
  });

  console.log(`[enrich-worker] started (poll=${POLL_MS}ms)`);
  void tick();
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
}

export function stopEnrichWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[enrich-worker] stopped");
  }
}
