// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract worker — reads source entities and produces placeholders.
 *
 * Polls source_extract_queue. For each source entity:
 *   1. Load the source content
 *   2. Call the LLM to identify notable subjects
 *   3. Create placeholder entities for each subject
 *   4. Create extracted_from relationships back to the source
 *   5. Queue each placeholder for drafting via wiki_draft_queue
 *
 * Reads go through the internal API client to prevent schema drift.
 * Queue operations stay as raw SQL (FOR UPDATE SKIP LOCKED atomicity).
 */

import { getLlmClient, isLlmConfigured } from "../llm.js";
import { withSystemActorContext } from "../actor-context.js";
import * as api from "./internal-api.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;

const POLL_MS = Number(process.env.EXTRACT_WORKER_POLL_MS) || 15_000;

// ---------------------------------------------------------------------------
// Queue operations (raw SQL — needs FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------

interface QueueRow {
  entity_id: string;
  owner_agent: string;
  attempts: number;
  max_attempts: number;
}

async function claimNext(): Promise<QueueRow | null> {
  return withSystemActorContext(async (sql) => {
    const rows = await sql.query(
      `UPDATE source_extract_queue
       SET status = 'processing', attempts = attempts + 1, started_at = NOW()
       WHERE entity_id = (
         SELECT entity_id FROM source_extract_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       ) RETURNING entity_id, owner_agent, attempts, max_attempts`,
      [],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;
    return {
      entity_id: String(row.entity_id),
      owner_agent: String(row.owner_agent),
      attempts: Number(row.attempts),
      max_attempts: Number(row.max_attempts),
    };
  });
}

async function markComplete(entityId: string, placeholdersCreated: number): Promise<void> {
  await withSystemActorContext(async (sql) => {
    await sql.query(
      `UPDATE source_extract_queue SET status = 'complete', placeholders_created = $2 WHERE entity_id = $1`,
      [entityId, placeholdersCreated],
    );
  });
}

async function markFailed(entityId: string, error: string, attempts: number, maxAttempts: number): Promise<void> {
  const status = attempts >= maxAttempts ? "failed" : "pending";
  await withSystemActorContext(async (sql) => {
    await sql.query(
      `UPDATE source_extract_queue SET status = $2, error = $3 WHERE entity_id = $1`,
      [entityId, status, error.slice(0, 500)],
    );
  });
}

async function recoverStuckRows(): Promise<number> {
  return withSystemActorContext(async (sql) => {
    const rows = await sql`
      UPDATE source_extract_queue SET status = 'pending'
      WHERE status = 'processing' AND attempts < max_attempts
      RETURNING entity_id
    `;
    return (rows as unknown[]).length;
  });
}

// ---------------------------------------------------------------------------
// Source loading via API
// ---------------------------------------------------------------------------

interface SourceInfo {
  id: string;
  label: string;
  description: string | null;
  content: string;
  spaceId: string;
}

async function loadSource(entityId: string): Promise<SourceInfo | null> {
  // Source entities are type='file', served by /files/{id}
  const entity = await api.getFile(entityId);
  if (!entity) return null;
  const props = entity.properties;
  const content = String(props.content ?? "");
  if (!content) return null;

  const spaceId = entity.space_ids?.[0] ?? "";

  return {
    id: entity.id,
    label: String(props.label ?? ""),
    description: typeof props.description === "string" ? props.description : null,
    content,
    spaceId,
  };
}

// ---------------------------------------------------------------------------
// Existing extraction lookup via API
// ---------------------------------------------------------------------------

interface ExistingExtraction {
  id: string;
  label: string;
  description: string;
  subjectType: string;
}

/**
 * Fetch all entities previously extracted from this source document
 * via extracted_from relationships. Used to make re-extraction idempotent.
 */
async function fetchExistingExtractions(sourceId: string): Promise<ExistingExtraction[]> {
  const rels = await api.getRelationships(sourceId, {
    direction: "in",
    predicate: "extracted_from",
    limit: 200,
  });

  return rels.map((rel) => {
    // direction=in: counterpart is in .source; direction=out: in .target
    const cp = rel.direction === "in" ? rel.source : rel.target;
    const props = cp?.properties ?? {};
    return {
      id: cp?.id ?? "",
      label: String(props.label ?? ""),
      description: String(props.description ?? ""),
      subjectType: String(props.subject_type ?? ""),
    };
  }).filter((e) => e.id !== "");
}

/** Simple case-insensitive match. Won't catch punctuation or abbreviation
 *  differences ("St. Augustine" vs "St Augustine") — the LLM prompt handles
 *  fuzzy matching, and the draft worker's dedup catches near-duplicates downstream. */
function normalizeLabel(label: string): string {
  return label.toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

interface ExtractedSubject {
  label: string;
  description: string;
  subject_type: string;
}

const EXTRACT_PROMPT = `You are an entity extractor for a knowledge graph wiki.

Given a source document, identify the notable subjects mentioned — people, organizations, concepts, events, places, books, theories, etc. For each, provide a label, a one-sentence description, and a semantic type.

Return ONLY a JSON object:
{
  "subjects": [
    {
      "label": "Name of the subject",
      "description": "One sentence describing what this is",
      "subject_type": "person|organization|concept|event|place|book|theory|other"
    }
  ]
}

Rules:
- Extract 5-30 subjects depending on document length and density
- Focus on subjects that deserve their own wiki page — skip trivial mentions
- Use the most canonical/common name for each subject
- Descriptions should be self-contained (understandable without the source)
- Do not extract the source document itself as a subject
- Prefer specific subjects over generic ones ("ATP Synthase" over "enzymes")`;

async function extractSubjects(
  content: string,
  sourceLabel: string,
  existing: ExistingExtraction[],
): Promise<ExtractedSubject[]> {
  const { client, model } = getLlmClient("draft"); // use draft config — extraction needs more tokens than exists

  const parts: string[] = [`Source document: "${sourceLabel}"\n\n${content.slice(0, 50_000)}`];

  if (existing.length > 0) {
    parts.push("\n\nPreviously extracted subjects from this document (do not re-extract these unless they need correction):");
    for (const e of existing) {
      parts.push(`- ${e.label} (${e.subjectType}): ${e.description}`);
    }
    parts.push("\nFocus on any subjects NOT already in the list above.");
  }

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: parts.join("\n") },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 4000,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as { subjects?: unknown[] };
    if (!Array.isArray(parsed.subjects)) return [];

    return parsed.subjects
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s) => ({
        label: String(s.label ?? "").trim(),
        description: String(s.description ?? "").trim(),
        subject_type: String(s.subject_type ?? "other").trim(),
      }))
      .filter((s) => s.label.length > 0);
  } catch {
    console.error("[extract-worker] Failed to parse LLM response:", raw.slice(0, 500));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core: process one source
// ---------------------------------------------------------------------------

async function processItem(row: QueueRow): Promise<void> {
  const tag = `[extract-worker] ${row.entity_id.slice(0, 8)}`;

  // Load actor via API
  const actor = await api.getActor(row.owner_agent);
  if (!actor) {
    await markFailed(row.entity_id, `owner_agent ${row.owner_agent} not found`, row.attempts, row.max_attempts);
    return;
  }

  // Load source entity via API
  const source = await loadSource(row.entity_id);
  if (!source) {
    console.log(`${tag} source entity gone, marking complete`);
    await markComplete(row.entity_id, 0);
    return;
  }
  if (!source.spaceId) {
    await markFailed(row.entity_id, "source has no space", row.attempts, row.max_attempts);
    return;
  }

  // Fetch what was already extracted from this source (idempotent re-extraction)
  const existing = await fetchExistingExtractions(source.id);
  const existingFromSource = new Set(existing.map((e) => normalizeLabel(e.label)));

  // Load all placeholders/wikis in the space to detect overlaps.
  // Build a map: normalizedLabel → { id, type } for three-bucket routing.
  const spaceEntities = await api.listAllEntities({
    space_id: source.spaceId,
    filter: "type:placeholder,type:wiki",
    view: "summary",
  });
  const spaceEntityMap = new Map<string, { id: string; type: string }>();
  for (const e of spaceEntities) {
    const props = e.properties ?? {};
    const label = String(props.label ?? "");
    if (label) {
      spaceEntityMap.set(normalizeLabel(label), { id: e.id, type: e.type });
      // Add to existing array so the LLM knows about them
      if (!existingFromSource.has(normalizeLabel(label))) {
        existing.push({
          id: e.id,
          label,
          description: String(props.description ?? ""),
          subjectType: String(props.subject_type ?? ""),
        });
      }
    }
  }

  console.log(
    `${tag} extracting from "${source.label}" (${source.content.length} chars, ${existing.length} known entities)`,
  );

  // Call LLM to identify subjects (passes existing subjects so it can focus on what's new)
  const subjects = await extractSubjects(source.content, source.label, existing);
  if (subjects.length === 0) {
    console.log(`${tag} no new subjects extracted`);
    await markComplete(row.entity_id, 0);
    return;
  }

  // Three-bucket split:
  //   1. Already extracted from THIS source → skip (idempotent)
  //   2. Matches an existing wiki in the space → enqueue enrichment
  //   3. Truly new (or matches only a placeholder) → create placeholder + enqueue draft
  const toEnrich: Array<{ wikiId: string; label: string }> = [];
  const toCreate: ExtractedSubject[] = [];
  let skipped = 0;

  for (const subject of subjects) {
    const norm = normalizeLabel(subject.label);

    // Bucket 1: already extracted from this source
    if (existingFromSource.has(norm)) {
      skipped++;
      continue;
    }

    // Check if a wiki/placeholder already exists in the space
    const match = spaceEntityMap.get(norm);
    if (match && match.type === "wiki") {
      // Bucket 2: existing wiki → enqueue enrichment
      toEnrich.push({ wikiId: match.id, label: subject.label });
    } else if (match) {
      // Existing placeholder — skip, draft is pending
      skipped++;
    } else {
      // Bucket 3: new subject
      toCreate.push(subject);
    }
  }

  console.log(
    `${tag} extracted ${subjects.length} subjects: ${skipped} skipped, ` +
    `${toEnrich.length} to enrich, ${toCreate.length} new`,
  );

  // Enqueue enrichments for existing wikis
  for (const { wikiId, label } of toEnrich) {
    try {
      const { status: enrichStatus } = await api.postEnrich(wikiId, source.id);
      if (enrichStatus === 202) {
        console.log(`${tag} enqueued enrichment for "${label}" (wiki=${wikiId.slice(0, 8)})`);
      } else if (enrichStatus === 200) {
        console.log(`${tag} "${label}" already enriched from this source`);
      }
    } catch (err) {
      console.warn(`${tag} failed to enqueue enrichment for "${label}":`, (err as Error).message);
    }
  }

  // Create placeholders + enqueue for drafting (existing path for new subjects)
  let created = 0;
  let reused = 0;
  if (toCreate.length > 0) {
    const { status, body: placeholderResult } = await api.postPlaceholders(
      toCreate.map((s) => ({
        label: s.label,
        description: s.description,
        subject_type: s.subject_type,
        relationships: [
          { target_id: source.id, predicate: "extracted_from", detail: `Extracted from "${source.label}"` },
        ],
      })),
      source.spaceId,
      { enqueueDraft: true },
    );

    if (status !== 201) {
      const errMsg = JSON.stringify(placeholderResult).slice(0, 400);
      throw new Error(`POST /wiki/placeholders returned ${status}: ${errMsg}`);
    }

    created = placeholderResult.created;
    reused = placeholderResult.reused;
  }

  console.log(
    `${tag} ${created} new placeholders created` +
    (reused > 0 ? `, ${reused} reused (deduped)` : "") +
    (toEnrich.length > 0 ? `, ${toEnrich.length} enrichments queued` : "") +
    `, done`,
  );
  await markComplete(row.entity_id, created);
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
      console.error(`[extract-worker] ${row.entity_id.slice(0, 8)} error:`, err);
      await markFailed(row.entity_id, `Unexpected: ${(err as Error).message}`, row.attempts, row.max_attempts).catch(() => {});
    }
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startExtractWorker(): void {
  if (timer) return;
  if (!isLlmConfigured()) {
    console.warn("[extract-worker] LLM not configured — extract worker disabled");
    return;
  }

  void recoverStuckRows().then((n) => {
    if (n > 0) console.log(`[extract-worker] recovered ${n} stuck row(s)`);
  });

  console.log(`[extract-worker] started (poll=${POLL_MS}ms)`);
  void tick();
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
}

export function stopExtractWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[extract-worker] stopped");
  }
}
