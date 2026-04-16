# Wiki Pipeline

The wiki pipeline turns LLM-authored markdown (with typed links) into a
structured graph of entities and relationships. Every relationship
carries a `span_text` provenance pointer back to the prose that
justified it, and every placeholder entity is reversible — the
pipeline is designed so that parallel writes converge rather than
conflict.

This document describes each LLM-using step: its role, inputs,
outputs, and where it plugs into the pipeline.

## Wiki metadata contract

Every wiki entity carries three required metadata fields alongside its
content. These are the primary inputs to all search/disambiguation
steps (resolve, exists, dedup) and are authored by whoever submits the
wiki — the draft LLM produces them in its JSON output; human submitters
include them in the POST /wiki body.

```typescript
type: "wiki"
properties: {
  label: string,               // 1-200 chars. Canonical display name, the article title.
  keywords: string[],          // 1-20 items, each 1-100 chars. Alternate names and
                               // search phrasings someone might use to find this wiki
                               // (acronyms, informal names, role-based references,
                               // translated names, tightly-associated concepts).
  short_description: string,   // 10-400 chars. One to two sentences of framing, shown
                               // in search previews and multi-choice disambiguation.

  content: string,             // Canonicalized markdown (links rewritten to [[entity:id]]).
  submitted_content: string,   // Original pre-canonicalization prose.
  primary_entities: string[],  // Entity IDs this wiki is "about".
  status: "draft" | "published" | "superseded",
}
```

Meilisearch flattens `properties` at index time, so `label`, `keywords`,
and `short_description` auto-become top-level searchable attributes
with no index config changes.

## The reusable `findSimilarEntities` primitive

The same "given a subject, find matching entities in the graph" pipeline
runs in three places:

| Caller  | Subject                                      | Candidate filter                        | Match semantics                          |
|---------|----------------------------------------------|-----------------------------------------|------------------------------------------|
| resolve | A `[[resolve:"..."]]` link in a wiki body   | All visible entities                    | Rewrite link → `[[entity:<match>]]`     |
| exists  | A placeholder the draft worker is about to expand | Published wikis (`type = "wiki"`)   | Redirect placeholder, skip drafting     |
| dedup   | A newly-published wiki                       | Other published wikis                   | Merge duplicate into canonical           |

All three call `findSimilarEntities(subject, options)` in
`server/lib/entity-resolve.ts`. The primitive implements:

1. **Query generation** (deterministic, no LLM). `buildCandidateQueries`
   in `server/lib/label-match.ts` produces up to 10 Meilisearch queries
   from the subject's `label + description + keywords`:
   - Raw label + normalized label
   - Each content-word token from the label (stop words filtered)
   - Every author-provided keyword as a standalone query
   - Short description (≤120 chars) as a phrase query + its content tokens
2. **Meilisearch union.** Each query runs against
   `attributesToSearchOn: ["label", "keywords", "short_description"]`
   so ranking is metadata-driven, not content-driven. Results are
   unioned by entity ID (preserving first-seen rank), capped at 20.
3. **Exact-label short-circuit (strict).** If exactly one candidate's
   label is identical to the target's (modulo case + whitespace only —
   honorifics, articles, and any other content words are NOT stripped),
   return that match with confidence 1.0 and no LLM call. Deliberately
   restrictive: `"Smith"` does not auto-match `"Dr. Smith"`, `"The
   Nile"` does not auto-match `"Nile"`. Anything requiring content-word
   reasoning must go through the LLM judge — silent auto-matches on
   label variations are the exact failure mode we're avoiding. See
   `strictNormalizeLabel` in `label-match.ts`.
4. **LLM judge.** One call; returns `{same_as_ids, different_ids,
   rationale}`. Multiple matches imply existing duplicates in the graph —
   the caller picks what it needs and the dedup poller will clean up.

The primitive is agnostic to caller. Callers differ in (a) the subject
shape they construct, (b) the `candidateFilter` they pass (`['type =
"wiki"']` for exists and dedup, none for resolve), and (c) which
`llmStep` config they use (resolve, exists, dedup — each can have its
own model via `~/.arkeon/llm.json`).

### Why this design

- **No LLM query generation.** The knowledge pipeline's dedupe (the
  inspiration for this design) doesn't need LLM query generation
  because `buildCandidateQueries` is already high-recall. An LLM
  alias-generation pre-step (like `consolidate.ts`'s `ALIAS_PROMPT`)
  would be a nice fallback for very sparse metadata, but the required
  `keywords` field makes it unnecessary for most cases — authors
  explicitly surface the synonyms/abbreviations they know about.
- **Metadata search, not content search.** Using
  `attributesToSearchOn` to narrow to label/keywords/short_description
  keeps ranking tight. The full wiki body is still indexed (via
  Meilisearch's default flattening), so future general-search endpoints
  work — but disambiguation pipelines don't get polluted by transient
  mentions in content.
- **One LLM call per subject.** Judging the whole candidate pool in
  one call with structured `same_as_ids / different_ids` output is
  strictly more informative than a per-candidate multi-choice: the LLM
  sees all candidates at once and can rank them relative to each other.

## Pipeline overview

```
POST /wiki                       Background workers
    │                                    │
    ▼                                    ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│          │    │          │    │          │    │          │
│ Stage 1  │───▶│ Stage 2  │    │ Stage 3  │    │ Stage 4  │
│ validate │    │ resolve  │    │ draft    │    │ dedup    │
│ + draft  │    │ + publish│    │          │    │          │
│          │    │          │    │          │    │          │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │               │
     │               ▼               ▼               ▼
     │            resolve          exists          dedup
     │              LLM             LLM             LLM
     │                               │
     │                               ▼
     │                             draft
     │                              LLM
     │
     ▼
 wiki stored as entity (type=wiki)
 placeholders queued in wiki_draft_queue
```

## Step: resolve  *(shipped, Phase 1)*

**When it runs:** Stage 2 of POST /wiki, once per `[[resolve:"Label"|"Description"]]` link in the submitted prose.

**Goal:** Decide whether a link target is (a) an existing entity already in the graph, or (b) a new concept that deserves its own placeholder.

**Subject passed to `findSimilarEntities`:**
```typescript
{
  label: link.label,              // author's short name
  description: link.description,  // optional author-provided description
  context: link.spanText,         // ~200 chars of surrounding prose — LLM context only
}
```

No `keywords` on the subject side — the author of a resolve link
doesn't write keywords (they just invoke the name). Candidate-side
keywords (on wiki candidates) do contribute to both search and LLM
disambiguation.

**Options:**
```typescript
{
  candidateFilter: [],    // all visible entities — wikis, people, topics, etc.
  llmStep: "resolve",
}
```

**Output handling** (`wiki-resolve.ts`):
- `findSimilarEntities()` returns `[]` → no match, caller handles as draft/gap per depth
- Returns one or more matches → take `matches[0]`, rewrite the link from `[[resolve:...]]` to `[[entity:<id>]]` in published content, create a `references` relationship with `span_text` in its properties

**Default model:** `gpt-4o-mini`
**Default max_tokens:** 256
**Env override:** `WIKI_RESOLVE_MODEL`

---

## Step: exists  *(planned, Phase 2a)*

**When it runs:** At the start of the **draft worker**, before any drafting LLM call, once per placeholder pulled off `wiki_draft_queue`.

**Goal:** Before spending tokens on drafting, check whether a published wiki already covers this placeholder's subject — even when the structural `primary_entities` check at POST /wiki wouldn't have caught it (two wikis about the same subject but declaring different `primary_entities`).

**Subject passed to `findSimilarEntities`:**
```typescript
{
  label: placeholder.properties.label,
  description: placeholder.properties.description,
  // Concatenate all inbound span_texts (truncated per-span) as context.
  // These are the prose fragments from every wiki that references this
  // placeholder — strong disambiguation signal for the LLM judge.
  context: inbound_spans.map(truncate).join("\n"),
}
```

No `keywords` on the subject side — a placeholder doesn't yet have
curated keywords. Candidate-side keywords (on the published wiki
candidates) do most of the matching work.

**Options:**
```typescript
{
  candidateFilter: ['type = "wiki"'],   // only look at existing wikis
  llmStep: "exists",
}
```

Exclude `status = "draft"` and `status = "superseded"` wikis from the
pool — only `published` wikis are valid matches. This is an additional
filter to add to `candidateFilter`.

**Output handling** (Phase 2a draft worker):
- Zero matches → proceed to the draft step
- One or more matches → redirect the placeholder entity to the matched
  wiki's primary entity (via `entity_redirects`), mark the draft queue
  entry `complete` with `merged_into: <existing_wiki_id>`, done. No
  drafting needed. If multiple matches came back, take the first (same
  rationale as resolve — the dedup poller will reconcile the others).

**Default model:** `gpt-4o-mini`
**Default max_tokens:** 512
**Env override:** `WIKI_EXISTS_MODEL`

**Open design question:** Should this check also run when a *human*
submits a POST /wiki directly, not just when the draft worker runs?
Current thinking: **no** — human submissions are authoritative and
respect the `primary_entities` the caller declared. Semantic duplicates
between human-submitted wikis go to the dedup step instead.

---

## Step: draft  *(planned, Phase 2a)*

**When it runs:** In the draft worker, after the exists step determines no match exists.

**Goal:** Synthesize a wiki body for the placeholder that the parent wiki asked to be drafted.

**Inputs (all passed to the LLM in a structured prompt):**

1. **Placeholder itself** — label, description, ID
2. **Inbound spans** — every `span_text` from relationships pointing at this placeholder (up to N, truncated per span to 400 chars). Critical: this tells the agent exactly how the concept has been used across other wikis.
3. **Nearby entities** — Meilisearch top 10 on `placeholder.label + placeholder.description`, filtered to `kind = "entity" AND type != "placeholder"`. Each candidate contributes its label, type, and description. The drafting agent can reference them via `[[entity:<id>]]` or `[[resolve:"<label>"]]`.
4. **Related published wikis** — Meilisearch top 5 on same query, filtered to `type = "wiki"`. First paragraph of each provides stylistic grounding.
5. **Space context** — if `space.properties.drafting_style_guide` is set (optional space field), include it verbatim. Lets a workspace set a voice ("academic," "personal Zettel," etc.).
6. **Remaining depth budget** — `MAX_DEPTH - current_depth`. If 0, the prompt explicitly says: use only `[[entity:...]]` or `[[resolve:"..."]]`, do not add `[[draft:"..."]]` because new placeholders won't be spawned.

**LLM prompt shape:**
```
You are writing a wiki page in a collaborative knowledge graph.

Your subject: "<placeholder.label>"
Description: "<placeholder.description>"

This subject has been referenced in the following contexts:
- "<span 1>"
- "<span 2>"
...

Nearby entities you may want to link to (use [[entity:<id>]] for
direct reference, or [[resolve:"<label>"|"<description>"]] if you're
unsure which):
- <entity 1 label> (<type>, id=<id>) — <description>
- <entity 2 label> (<type>, id=<id>) — <description>
...

Related published wikis for context (do not duplicate their content):
- <wiki 1 label>: <first paragraph>
- <wiki 2 label>: <first paragraph>
...

Space style guide: <if set>

Depth budget: <N> levels remaining. <If 0: Use only existing entities or
resolve: links. Do not create new [[draft:...]] placeholders.>

Write a wiki body in markdown, 300-1500 words, that:
- Uses [[entity:<id>]] for direct references to the entities listed
  above when you know which one you mean
- Uses [[resolve:"<Label>"|"<Description>"]] for concepts you're
  introducing that probably already exist somewhere in the graph
- Uses [[draft:"<Label>"|"<Description>"]] for concepts that clearly
  need their own page but haven't been written yet (only if depth > 0)
- Uses [[gap:"<Label>"|"<Description>"]] for concepts you mention but
  don't want to expand

ALSO produce the wiki's metadata:
- label: the canonical title for this page (usually the subject's label)
- keywords: 3-10 alternate names / search phrasings someone might use
  to find this wiki (acronyms, informal names, role-based references,
  tightly-associated concepts)
- short_description: one to two sentences of framing, shown in search
  previews and disambiguation prompts

Respond with ONLY a JSON object:
  {
    "can_draft": true | false,
    "label": "<canonical title>",
    "keywords": ["...", "...", "..."],
    "short_description": "<1-2 sentences>",
    "content": "<markdown body>",
    "primary_entities": ["<placeholder_id>"],
    "notes": "<one-sentence summary>",
    "refused_reason": "<required if can_draft is false>"
  }
```

The draft worker submits the full object as the POST /wiki body. The
route validates the metadata fields the same as any other submission —
no special path for draft-worker-authored wikis.

**Outputs:**
- `can_draft: true` → Submit to POST /wiki with `depth = queue.depth`, `content`, `primary_entities`, on behalf of the draft worker's actor. The POST /wiki pipeline then validates links, resolves resolve: links (recursive LLM call), and publishes.
- `can_draft: false` → Mark queue entry `undraftable` with the refused reason. Placeholder entity stays in the graph; its `properties.status` transitions to `undraftable`.

**Post-submission handling:**
- POST /wiki returns **201** → mark queue entry `complete`, link the drafted wiki's ID on the queue row for audit.
- POST /wiki returns **409 wiki_exists** → someone raced us. Redirect the placeholder to the existing wiki's primary entity; mark queue entry `complete` with the conflict noted.
- POST /wiki returns **400 malformed_wiki_links** → re-prompt the draft LLM once with the parse errors, retry. If it fails again, mark queue entry `failed`.
- POST /wiki returns **404** (bad entity: ID the LLM invented) → re-prompt once: "the following entity IDs don't exist, use resolve: instead," retry.
- POST /wiki returns **5xx** → exponential backoff, increment `attempts`, respect `max_attempts`.

**Default model:** `gpt-4o`
**Default max_tokens:** 8000
**Env override:** `WIKI_DRAFT_MODEL`

**Open design questions:**
- Do we cap the number of `[[resolve:...]]` links the draft LLM can emit? Each resolve triggers its own resolve-LLM call during POST /wiki publishing — a wiki with 50 resolves is 50 Meilisearch+LLM round-trips. Soft cap (prompt) or hard cap (truncate at link count)?
- How do we handle the drafted wiki needing media (images, PDFs)? For now it doesn't — the content is pure markdown — but eventually the draft agent should be able to reference content entities. Defer to Phase 3.
- Actor attribution: does the drafted wiki's `owner_id` belong to (a) the `owner_agent` recorded when the placeholder was created, or (b) a system "draft worker" actor? Current thinking: (a). The agent that asked for the draft owns the result.

---

## Step: dedup  *(planned, Phase 2b)*

**When it runs:** Sequential dedup poller, watches newly-published wikis. Runs in the background after the main write path, not inline.

**Goal:** When two wikis about the same subject get published (either because two agents raced past the exists check, or because a human submitted one that overlaps semantically with an existing one), merge them into a single canonical wiki that preserves every link from both sources.

**Finding candidates — `findSimilarEntities` call:**

```typescript
// Subject is the new wiki itself — authored metadata is the query seed.
const subject = {
  label: newWiki.properties.label,
  description: newWiki.properties.short_description,
  keywords: newWiki.properties.keywords,
  // No context field needed — the subject's own metadata is rich enough.
};

const options = {
  candidateFilter: [
    'type = "wiki"',
    `id != "${newWiki.id}"`,   // don't self-match
    // Only consider published wikis as merge targets
  ],
  llmStep: "dedup",
};
```

This is the cleanest case for the primitive — the new wiki has
authored keywords (from the draft LLM or human submitter), so query
generation is high-recall out of the gate. No LLM query-generation
pre-step needed; no need to crack open the content.

**Output handling:**
- Zero matches → nothing to do, poller moves on
- One or more matches → for each, score confidence, then route to auto-merge (high) or review queue (medium). The actual merge itself is a separate LLM call (the "editing prompt" below) rather than part of the primitive.

**Inputs to the merge LLM:**
- Both wikis' full `content` (post-canonicalization, with `[[entity:...]]` links)
- Both wikis' `primary_entities`, `owner_id`, `created_at`
- List of every outbound link target (entity ID + predicate + span text) from both sources

**LLM prompt shape (framed as editing, not merging, to preserve voice):**
```
You are updating a canonical wiki to incorporate information from a
duplicate wiki on the same subject.

Canonical wiki:
<full content of canonical>

Duplicate wiki:
<full content of duplicate>

Edit the canonical wiki to incorporate any unique information from the
duplicate. You must preserve every [[entity:...]] link from both
wikis. If you believe a link should be dropped (because it's redundant
or contextually wrong after the merge), list it in "dropped_links"
with a one-sentence justification.

Respond with ONLY a JSON object:
  {
    "content": "<merged markdown body>",
    "primary_entities": ["<merged list>"],
    "dropped_links": [
      { "entity_id": "<id>", "reason": "<sentence>" }
    ]
  }
```

**Verification before committing the merge:**
- Parse the merged `content` with `parseWikiLinks`; every `[[entity:<id>]]` from both sources must appear in the output OR in `dropped_links`
- If anything is missing without justification, reject the merge and queue for human review
- `dropped_links` justifications are logged in the merge's version-history note for audit

**Committing:**
1. Submit the merged content through POST /wiki as a new revision of the canonical wiki (the one chosen as the merge target — heuristic: older `created_at`, more outbound links)
2. Mark the duplicate wiki as `status = "superseded"`, set its `redirect_to` to the canonical wiki
3. Update every relationship whose `source_wiki_id = <duplicate>` to point at the canonical
4. Update every entity whose `wiki_id = <duplicate>` to reference the canonical

Original wiki is kept (marked `superseded`), never deleted — reversibility.

**Default model:** `gpt-4o`
**Default max_tokens:** 16000
**Env override:** `WIKI_DEDUP_MODEL`

**Open design questions:**
- Which wiki wins as the merge target when both are high-quality?
- When `primary_entities` differ between the two wikis, what's the merged `primary_entities`? Union? Agent's choice?
- Do we merge immediately, or always queue for human review? High-confidence threshold for auto-merge vs. always-review is a policy choice.

---

## Configuration

All four steps share the same infrastructure, differing only in default model and token budget.

**Config file:** `~/.arkeon/llm.json` (override path with `WIKI_LLM_CONFIG_PATH`)

```json
{
  "default": {
    "provider": "openai",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-4o-mini"
  },
  "draft":  { "model": "gpt-4o", "max_tokens": 8000 },
  "dedup":  { "model": "gpt-4o", "max_tokens": 16000 }
}
```

**Resolution order** (highest priority first):
1. Step-specific env var: `WIKI_RESOLVE_MODEL`, `WIKI_EXISTS_MODEL`, `WIKI_DRAFT_MODEL`, `WIKI_DEDUP_MODEL` *(model only)*
2. Step block in `~/.arkeon/llm.json`
3. `default` block in the same file
4. `OPENAI_API_KEY` / `OPENAI_BASE_URL` env vars
5. Hardcoded per-step defaults (below)

**Hardcoded defaults:**

| Step    | Default model  | Default max_tokens |
|---------|----------------|--------------------|
| resolve | gpt-5.4-nano   | 256                |
| exists  | gpt-5.4-nano   | 512                |
| draft   | gpt-5.4-nano   | 8000               |
| dedup   | gpt-5.4-nano   | 16000              |

Nano is the universal default. Override per step via `llm.json` (or the
step-specific env vars) to route draft/dedup to a stronger model when
quality demands it.

**Provider per step:** Supported via the config file — set `api_key` and `base_url` inside a step block to route that step to a different provider (e.g., resolve on a cheap local model via Ollama, draft on OpenAI). There's no env-var version of this; deployments that need multi-provider routing configure via file.

## Staging config via `arkeon init`

```bash
arkeon init \
  --llm-provider openai \
  --llm-base-url https://api.openai.com/v1 \
  --llm-api-key sk-... \
  --llm-model gpt-5.4-nano
```

Writes `~/.arkeon/llm.json` with just the `default` block populated. Per-step overrides are a hand-edit afterward.

## Testing

### The `POST /resolve` endpoint

The `findSimilarEntities` primitive is exposed as a standalone endpoint
for pre-resolving subjects before submitting a wiki, for UI search
disambiguation, and as a testing surface.

```bash
curl -X POST http://localhost:8000/resolve \
  -H 'X-API-Key: ak-...' \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "Matthew Connelly",
    "description": "Historian of secrecy at Columbia",
    "space_id": "01K...",
    "candidate_filter": ["type = \"person\""]
  }'

# Response:
# {
#   "matches": [
#     { "id": "01H...", "confidence": 0.8, "rationale": "Keyword match on \"Matthew Connelly\"" }
#   ],
#   "actor_read_level": 2
# }
```

Returns 503 `llm_not_configured` if no LLM provider is set.

### Manual end-to-end suite

`test/manual/wiki-resolve.test.ts` exercises the resolve pipeline
against a live model. Boundary cases covered:

- Exact + normalized label match (short-circuit path)
- Alias / keyword-driven matching
- Acronym expansion both directions
- Polysemy disambiguation via description ("Mercury" planet vs element)
- Polysemy with no description (expect ambiguity / null)
- Duplicate-entity recognition (LLM flags both canonical + variant IDs)
- Near-neighbor rejection (related-but-distinct concepts)
- No-candidate case (subject not in graph → empty matches, no LLM call)
- Space scoping
- Candidate filter (`type = "wiki"`) targeting

Seed fixture (`test/manual/wiki-resolve-seed.ts`) populates a space
with: Matt Connelly, William Smith + Dr. Smith (duplicate pair), Mercury
the planet vs. Mercury the element, NATO, a BENGAL wiki, a general
declassification-policy wiki.

**Running:**

```bash
# With a live LLM key — spins up a scratch stack on ports 18000/18433/18700
OPENAI_API_KEY=sk-... ./scripts/test-resolve-live.sh

# Or against an already-running `arkeon up` daemon
ADMIN_BOOTSTRAP_KEY=ak-... ./scripts/test-resolve-live.sh --use-running
```

The full suite is ~12 LLM calls, each a few hundred tokens. On nano
it costs well under a penny per run. Each test logs the model's
rationale on the matches for easy inspection when something regresses.

## Status

| Step    | Status | Tracked in |
|---------|--------|-----------|
| **shared primitive** | shipped | `server/lib/entity-resolve.ts`, `server/lib/label-match.ts` |
| resolve | shipped | `server/lib/wiki-resolve.ts` (thin adapter over the primitive) |
| exists  | planned — Phase 2a | new: `server/lib/wiki-exists.ts` |
| draft   | planned — Phase 2a | new: `server/lib/wiki-draft-worker.ts` |
| dedup   | planned — Phase 2b | new: `server/lib/wiki-dedup-poller.ts` |

Phase 2a callers (exists, draft worker) and Phase 2b (dedup poller)
reuse `findSimilarEntities` with different `candidateFilter` /
`llmStep` options. The per-step LLM models are independently
configurable via `~/.arkeon/llm.json` (see Configuration below).
