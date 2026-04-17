# Wiki Pipeline

The wiki pipeline turns markdown pages with typed links into a graph. In the
wiki-first model, the page itself is the canonical graph entity for its subject:
there is no separate required `primary_entities` list and no automatic `about`
edge. A page titled "René Girard" is the graph node other pages resolve and link
to.

## Wiki Metadata

Every wiki entity stores authored metadata alongside canonicalized markdown:

```typescript
type: "wiki"
properties: {
  label: string,               // Article title and canonical subject label.
  subject_type?: string,       // Optional semantic type: person, concept, book, event.
  aliases?: string[],          // Alternate titles/spellings used for duplicate checks.
  keywords: string[],          // Search/disambiguation phrases.
  short_description: string,   // One to two sentence search preview.
  content: string,             // Markdown with links rewritten to [[entity:id]].
  submitted_content: string,   // Original submitted markdown.
  status: "draft" | "published" | "superseded",
}
```

Meilisearch flattens `properties` at index time, so `label`, `aliases`,
`keywords`, `subject_type`, and `short_description` become searchable without
special schema work.

## Create Flow

`POST /wiki` does the synchronous work needed to publish a page:

1. Resolve the target space and require contributor access.
2. Parse typed links in `content`.
3. Validate `[[entity:...]]` links and rewrite merged IDs to canonical IDs.
4. Reject duplicate pages in the same space when the normalized `label` or any
   `aliases` overlap an existing wiki. Normalization folds case, whitespace, and
   diacritics, so `René Girard` conflicts with `Rene Girard`.
5. Mint placeholders for `[[placeholder:...]]` and `[[assign:...]]` links.
6. Resolve `[[resolve:...]]` links through Meilisearch plus the LLM judge when an
   LLM is configured. If no match is found, mint an unqueued placeholder.
7. Create `references` relationships from the published wiki to every linked
   target, with `span_text` copied from the surrounding prose.
8. Publish the wiki and index it in Meilisearch.

## Link Syntax

```text
[[entity:ULID]]
[[resolve:"Label"|"Description"]]
[[placeholder:"Label"|"Description"]]
[[assign:"Label"|"Description"]]
```

- `entity` is a hard reference to a visible entity.
- `resolve` asks the server to find an existing match and soft-degrades to an
  unqueued placeholder on miss or when no LLM is configured.
- `placeholder` creates an inert stub for navigation/reference.
- `assign` creates a placeholder and queues it in `wiki_draft_queue` for a
  future drafting worker.

At max recursion depth, `assign` links are demoted to `placeholder` so drafting
cannot fan out forever.

## Duplicate Policy

Inline duplicate prevention is intentionally deterministic and page-first:

- Same normalized label in the same space: `409 wiki_exists`.
- Label matching an existing alias, or alias matching an existing label/alias:
  `409 wiki_exists`.
- Different spaces may have pages with the same label.
- Semantic near-duplicates that do not share a label/alias are left for a future
  dedup/review worker.

The conflict response includes `existing_wiki_id` so clients can update or link
to the existing page rather than create another one.

## Resolve Primitive

`server/lib/entity-resolve.ts` still provides the shared
`findSimilarEntities(subject, options)` primitive for soft entity matching:

1. Generate deterministic Meilisearch queries from label, description, and
   keywords.
2. Union candidate IDs across queries.
3. Short-circuit exact label matches when exactly one candidate matches under
   strict case/whitespace normalization.
4. Otherwise call the LLM judge for disambiguation.

`[[resolve:...]]` uses this primitive against visible entities in the target
space. Future background workers can reuse the same primitive for placeholder
existence checks and semantic wiki deduplication.

## Planned Background Work

### Draft Worker

The draft worker will poll `wiki_draft_queue`, gather inbound `span_text`
contexts for the placeholder, and draft a new wiki page:

```json
{
  "label": "ATP Synthase",
  "type": "concept",
  "aliases": ["F-type ATPase"],
  "keywords": ["ATP synthase", "oxidative phosphorylation"],
  "short_description": "Enzyme complex that synthesizes ATP from a proton gradient.",
  "content": "...markdown with typed links...",
  "space_id": "01..."
}
```

Before drafting, it should check for an existing wiki with the same label/alias
or a high-confidence semantic match. If one exists, the placeholder should
redirect to that wiki instead of generating a duplicate page.

### Dedup Worker

The dedup worker should watch published wikis and search for semantic
duplicates that deterministic label/alias checks missed. High-confidence cases
can be routed to merge/review; uncertain cases should remain separate because
false merges are worse than duplicate pages.

## LLM Configuration

All LLM-using steps share `server/lib/llm.ts`.

Config file: `~/.arkeon/llm.json` (override with `WIKI_LLM_CONFIG_PATH`)

```json
{
  "default": {
    "provider": "openai",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-5.4-nano"
  },
  "draft": { "model": "gpt-5.4-nano", "max_tokens": 8000 },
  "dedup": { "model": "gpt-5.4-nano", "max_tokens": 16000 }
}
```

Resolution order:

1. Step-specific model env var, such as `WIKI_RESOLVE_MODEL`.
2. Step block in `llm.json`.
3. `default` block in `llm.json`.
4. `OPENAI_API_KEY` / `OPENAI_BASE_URL`.
5. Hardcoded per-step defaults.
