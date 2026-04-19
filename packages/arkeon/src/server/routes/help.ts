// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";

import {
  WHAT_IS_ARKEON,
  CORE_CONCEPTS,
  AUTHENTICATION,
  BEST_PRACTICES,
} from "../../shared";
import {
  renderIndexFromSpec,
  renderPreamble,
  renderRouteHelpFromSpec,
  renderRouteNotFoundFromSpec,
} from "../lib/openapi-help";
import { requireActor } from "../lib/http";
import type { AppBindings } from "../types";

const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
};

// ---------------------------------------------------------------------------
// Guide content
// ---------------------------------------------------------------------------

export const GENERAL_GUIDE = `# Arkeon — Getting Started

## What is Arkeon?

${WHAT_IS_ARKEON}

## Core Concepts

${CORE_CONCEPTS}

## Authentication

${AUTHENTICATION}

The route index (GET /help) shows each route's auth requirement.

## Your First Workflow

1. Create a wiki
   POST /wiki
   {
     "label": "Hello",
     "type": "note",
     "keywords": ["hello"],
     "short_description": "A short description for search previews.",
     "content": "My first wiki."
   }
2. List wikis/entities
   GET /wiki

3. Create relationships
   Add typed [[links]] to wiki content. Relationships are materialized when
   the wiki publishes; there is no direct relationship creation endpoint.

4. Search
   GET /search?q=hello

## Working Within a Space

Spaces are organizational containers. Pass space_id to POST /wiki to
publish into a specific space.

You can also add entities to spaces directly:
   POST /spaces/{id}/entities          — add existing entity to space

## Filtering

Any listing endpoint supports the filter query param. The full syntax
(operators, column names, property paths) is documented at the top of the
route index — run GET /help to see it.

## Best Practices

${BEST_PRACTICES}

## Tools

Beyond direct HTTP calls, Arkeon provides a CLI and a TypeScript SDK that handle
authentication and pagination for you.

### CLI

Install:  npm install -g arkeon
Config:   export ARKE_API_URL=https://<your-instance>.arkeon.tech
          export ARKE_API_KEY=<your-api-key>
Usage:    arkeon entities list
          arkeon entities create --type note --properties '{"title":"Hello"}'
          arkeon search --q hello
          arkeon --help

The CLI is auto-generated from the API's OpenAPI spec, so every route is
available as a command. Use --help on any command for full options.

## Getting More Help

GET /help                         Full route index with auth & summary
GET /help/GET/wiki/{id}           Detailed docs for any specific route
GET /help/guide/wiki              Authoring wikis with typed links
GET /help/guide/auth              Authentication and profiles
GET /help/guide/workers           Worker and LLM configuration
GET /help/guide/explorer          Explorer graph + screenshot server docs
GET /llms.txt                     Machine-readable route index
`;

const ADMIN_GUIDE = `# Arkeon — Admin Guide

This guide covers operations that require admin privileges.

## What Admins Can Do

- Create and manage actors and API keys
- Rebuild search indexes
- View instance-wide statistics

## Managing Actors

Create an actor:
  POST /actors
  {
    "kind": "agent",
    "properties": { "label": "Researcher" }
  }

Generate an API key for them:
  POST /actors/{id}/keys

Only kind "agent" is supported. (Legacy "worker" actors from earlier
releases remain readable, but the runtime that invoked them has been
removed.)

## Spaces

Create a space:
  POST /spaces
  { "name": "Design Review" }

Spaces are organizational containers. Any authenticated actor can read
all spaces and entities. The space owner or a system admin can update
or delete a space.

Add an entity to a space:
  POST /spaces/{id}/entities
  { "entity_id": "<id>" }

## Admin Endpoints

GET  /admin/stats             entity count, actor count, DB size, etc.
POST /admin/reindex           rebuild the Meilisearch full-text index
GET  /admin/instance          instance metadata
PUT  /admin/actors/{id}       update actor fields directly

## Best Practices

Organize with spaces.
  Spaces are like directories for your knowledge graph. Create a space for
  each project, domain, or workstream and assign entities to it. Most entities
  should live in at least one space — ungrouped entities become hard to manage
  as the graph grows. Spaces can be nested, so you can build a hierarchy
  that mirrors your organization (e.g., "Engineering" > "Backend" > "API v2").

Encourage connected graphs.
  Set the expectation that entities should be linked via relationships rather
  than left as isolated nodes. The value of the graph compounds with
  connectivity — isolated entities are just a database.

## Next Steps

See GET /help for the full route index.
See GET /help/<METHOD>/<path> for detailed docs on any route.
`;

const WIKI_GUIDE = `# Arkeon — Authoring Wikis

## What is a wiki?

A wiki in Arkeon is a long-form markdown entity (type="wiki") about one or
more primary entities. It's the canonical place to write *what you know* about
a subject. Typed links inside the markdown body get parsed and materialized as
real relationships in the graph, so the wiki itself becomes a connective-tissue
node — the more wikis you author, the richer the graph gets automatically.

Wikis are submitted via POST /wiki and published synchronously. The body is
validated, links are resolved or soft-degraded, placeholders are minted for
anything unresolved, relationships are created, and the wiki is promoted from
'draft' to 'published' all in one request.

## The four link types

All links use the \`[[ ... ]]\` form. Exactly four types:

  [[entity:ULID]]
      Hard reference to an existing visible entity. The unquoted ULID must
      resolve to an entity the actor can read; 404 otherwise. Redirects
      are followed — published content is rewritten to the canonical ID.

  [[resolve:"Label"|"Description"]]
      Ask the server to find a matching entity via Meilisearch candidate
      search + LLM-judged disambiguation. If a match is found, the link
      becomes an [[entity:ID]] reference. If not — because the LLM judge
      rejected all candidates, Meilisearch found nothing, or no LLM is
      configured — the link SOFT-DEGRADES to a placeholder. The wiki still
      publishes; a \`resolve_warnings\` array in the response tells you which
      links degraded and why. The wiki submission never fails over an LLM
      config issue.

  [[placeholder:"Label"|"Description"]]
      Unwritten stub. Mint a placeholder entity but don't queue it for
      drafting. Use when you want to flag "this thing should probably
      exist" without committing yourself or anyone else to writing it.
      A human or LLM may come back later and fill it in.

  [[assign:"Label"|"Description"]]
      Hand off to the background drafter. Mints a placeholder AND queues
      it in \`wiki_draft_queue\` for a worker process to eventually expand
      into a real wiki. Use when you want auto-drafting.

Labels must be double-quoted. Description is optional for resolve /
placeholder / assign but strongly recommended — it gives the resolver (or
a future drafter) context beyond the bare label. Entity IDs are unquoted
ULIDs.

## How to choose

  resolve     You believe the thing probably already exists in the graph,
              and you want the server to connect it.

  placeholder You want a stub for navigation / reference purposes but don't
              want anything auto-drafted. The link is inert until someone
              picks it up.

  assign      You want this drafted. Hand it off to a background worker.

## A worked example

POST /wiki
{
  "label": "Photosynthesis",
  "type": "concept",
  "aliases": ["Plant photosynthesis"],
  "keywords": ["photosynthesis", "light reaction", "calvin cycle"],
  "short_description": "Process by which plants convert light energy into chemical energy.",
  "content": "...see below..."
}

Body content (using <<...>> as illustrative delimiters so the doc parser
doesn't eat these):

  # Photosynthesis

  Photosynthesis converts light energy into chemical energy, primarily in
  the chloroplasts of <<entity:01ABC...>>. It has two stages: the light
  reactions (in the <<resolve:"Thylakoid Membrane"|"Site of the light reactions">>)
  and the <<resolve:"Calvin Cycle"|"The light-independent carbon fixation stage">>.

  ## Related concepts

  - <<placeholder:"Chlorophyll"|"Pigment that absorbs light in chloroplasts">>
  - <<assign:"ATP Synthase"|"Enzyme that couples proton flow to ATP production">>

What happens:
  - The entity link resolves to a real chloroplast entity.
  - "Thylakoid Membrane" and "Calvin Cycle" go through resolve: candidate
    match + LLM judge. If the graph has them, they link to the real
    entities. If not, placeholders are minted and resolve_warnings records
    the reason.
  - "Chlorophyll" becomes a non-queued placeholder — inert stub.
  - "ATP Synthase" is queued for the background drafter.
  - Every link becomes a \`references\` relationship from this wiki.

## space_id

\`space_id\` is optional. If omitted, the server picks the single space the
actor can contribute to. If the actor has zero or multiple contributable
spaces, the server returns 400 — pass space_id explicitly in that case.

## Response

On success (201):

  wiki                     The published wiki entity.
  placeholders             IDs of placeholder entities minted this request,
                           each with status 'placeholder' or 'assigned'.
  relationships_created    Count of \`references\` edges created.
  resolve_warnings         Present only if any resolve: link soft-degraded.
                           Each warning: { label, reason }.
                           reason is "llm_not_configured" or "no_match".

## Writing about link syntax inside a wiki

The parser scans every \`[[...]]\` pair in the content, including inside code
fences. To discuss link syntax in prose — like this very guide does — use
alternative delimiters (\`<<entity:id>>\` or similar), or describe the shape
in words.

## Errors

400 malformed_wiki_links     One or more links are syntactically wrong.
                             \`details\` lists each offending link with a
                             reason and correct syntax.
404 not_found                An [[entity:id]] link pointed at a non-existent
                             or invisible entity.
409 wiki_exists              A wiki with the same normalized label or alias
                             already exists in the target space. Response
                             includes \`existing_wiki_id\` — update it,
                             don't duplicate.
400 no_default_space         space_id omitted and actor has no contributable
                             spaces. Create one first.
400 ambiguous_default_space  space_id omitted and actor has multiple
                             contributable spaces. Pass space_id explicitly.

## See also

POST /resolve                       Standalone subject → candidate-matches primitive
GET  /wiki/{id}                     Read the published wiki as an entity
GET  /wiki/{id}/relationships       See the materialized edges
`;

const AUTH_GUIDE = `# Arkeon — Authentication & Profiles

## Authentication Model

Arkeon uses API keys to authenticate requests. Every request must include
an \`X-API-Key\` header. Keys are tied to actors — each actor can have
multiple keys, but each key belongs to exactly one actor.

Actors represent identities in the system. An actor has a kind ("agent"),
a label, and optional properties. Admin actors can manage other actors;
non-admin actors can read/write entities within their access level.

## Self-Service Registration (not yet available)

The CLI includes commands for self-registration via Ed25519 + proof-of-work
(\`arkeon-wiki auth register\`, \`arkeon-wiki auth recover\`), but the server
endpoints they call are not yet implemented. These commands will work once
the server routes land.

Until then, new actors must be created by an admin via \`POST /actors\` or
\`arkeon-wiki auth add <name>\` (which calls POST /actors under the hood).

If you have an admin-issued API key, store it directly:
  arkeon-wiki auth set-api-key <your-key>

## Auth Profiles

Profiles let you maintain per-repo actor identities. Each profile stores
the actor name, API key, and instance URL.

### CLI Commands

  arkeon-wiki auth register         Self-register (not yet available — server routes pending)
  arkeon-wiki auth recover          Recover API key (not yet available — server routes pending)
  arkeon-wiki auth set-api-key <k>  Set API key directly (e.g. admin-issued)
  arkeon-wiki auth status           Show current auth state and actor info
  arkeon-wiki auth whoami           Alias for auth status
  arkeon-wiki auth logout           Clear current auth credentials
  arkeon-wiki auth profiles         List all saved profiles
  arkeon-wiki auth use <name>       Switch to a named profile
  arkeon-wiki auth add <name>       Create a new named profile
  arkeon-wiki auth remove <name>    Delete a named profile

### Auth Priority Chain

When resolving which API key to use, the CLI checks in order:

  1. ARKE_API_KEY environment variable (highest priority)
  2. Per-repo actor key stored in .arkeon/state.json
  3. Global credentials in ~/.arkeon-wiki/credentials.json

The first non-empty value wins. Use env vars for CI/scripts, per-repo
keys for project-specific identities, and global credentials as the
default fallback.
`;

const WORKERS_GUIDE = `# Arkeon — Worker & LLM Configuration

## Overview

Workers are background processes that use LLMs to extract entities,
draft wikis, and resolve links. Their behavior is controlled by a YAML
config file.

## File Location

  Default:   ~/.arkeon-wiki/workers.yaml
  Override:  ARKEON_WORKERS_CONFIG=/path/to/workers.yaml

If the file does not exist, built-in defaults are used for all settings.

## Full Schema

  # Global LLM defaults — every worker inherits these unless overridden.
  llm:
    provider: openai
    base_url: https://api.openai.com/v1
    api_key: sk-...
    model: gpt-4o
    max_tokens: 4096

  workers:
    extractor:
      enabled: true
      prompt_mode: append
      prompt: "Domain-specific extraction rules..."
      llm: { model: gpt-4o-mini }
      steps:
        resolve: { model: gpt-4o-mini, max_tokens: 256 }
        exists: { model: gpt-4o-mini, max_tokens: 512 }
    drafter:
      enabled: true
      poll_interval: 10s
      batch_size: 5
      max_depth: 2
      llm: { model: gpt-4o, max_tokens: 8000 }

## Resolution Priority

LLM settings resolve from most specific to least specific:

  step > worker > global > hardcoded defaults

For example, if the extractor's "resolve" step sets model: gpt-4o-mini,
that overrides the extractor-level model, which overrides the global
model. Any field not set at a given level falls through to the next.

## Prompt Modes

The prompt_mode field controls how a worker's custom prompt interacts
with the built-in system prompt:

  replace   Full override — your prompt replaces the built-in prompt
            entirely. Use when you need complete control.
  prepend   Your prompt is inserted before the built-in prompt.
            Good for adding context or domain rules.
  append    Your prompt is added after the built-in prompt (default).
            Good for supplementary instructions.

## Duration Strings

The poll_interval field accepts human-readable duration strings:

  ms   milliseconds   (e.g. 500ms)
  s    seconds        (e.g. 10s)
  m    minutes        (e.g. 2m)
  h    hours          (e.g. 1h)

## Hot Reload

The config file is cached by mtime + file size. Edits take effect
without restarting the server — the next worker tick picks up changes
automatically.
`;

const EXPLORER_GUIDE = `# Arkeon — Explorer & Visual Inspection

## What is the Explorer?

The Explorer is a browser-based graph visualization served at GET /explore.
It renders every entity in your instance as a force-directed graph using
Sigma.js (WebGL). Nodes represent entities, edges represent relationships.

## Accessing the Explorer

Open your instance URL with /explore:

  https://<instance>.arkeon.tech/explore

Authentication is automatic when served from the instance — the API key is
injected into the page. You can also pass a key manually:

  /explore?key=<api-key>

## Interacting with the Graph

- Click a node to select it — the detail panel opens on the right showing
  properties, relationships, and comments.
- Click an edge to select the relationship — shows the triplet view
  (source -> predicate -> target).
- Hover over nodes/edges — cursor changes to pointer, hovered element
  highlights. Neighbors of a hovered node show labels.
- When a node is selected, labels appear on the selected node and all its
  direct neighbors.
- Click the background to deselect.
- Scroll to zoom, drag to pan.

## URL Parameters

  select=<entity-id>   Pre-select and zoom to an entity on load
  mode=graph|feed      Switch between graph view and activity feed
  cap=N                Maximum entities to load (default 3000)
  mock                 Use built-in fixture data (dev only, no instance needed)

## Screenshot Server (for LLM agents)

The screenshot server lets agents visually inspect the graph without a
browser. It runs a headless Chromium that renders the explorer and returns
a PNG image.

### Starting the server

  node packages/explorer/scripts/screenshot-server.mjs

This starts an HTTP server on 127.0.0.1:3200.

### Taking screenshots

  # Full graph
  curl http://localhost:3200/screenshot -o /tmp/graph.png

  # With a specific entity selected and zoomed
  curl "http://localhost:3200/screenshot?select=<entity-id>" -o /tmp/graph.png

  # Dev mode with mock data (no running instance needed)
  curl "http://localhost:3200/screenshot?mock" -o /tmp/graph.png

### Screenshot parameters

  select=<id>   Entity to select and zoom to
  mock          Use mock fixture data
  width=N       Viewport width in pixels (default 1400, max 3840)
  height=N      Viewport height in pixels (default 900, max 2160)
  wait=N        Ms to wait for layout to settle (default 3000, max 10000)

### Environment variables

  EXPLORER_URL      Base URL of the explorer (default http://localhost:8000/explore/)
  SCREENSHOT_PORT   Port to listen on (default 3200)

### Agent workflow

An LLM agent can use this to verify visual changes:

  1. curl http://localhost:3200/screenshot -o /tmp/graph.png
  2. Read /tmp/graph.png (multimodal — the image is returned inline)
  3. Assess the visual state of the graph

The server keeps the browser warm between requests, so subsequent
screenshots are fast (~3s for layout settling, no cold start).
`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createHelpRouter(getSpec: () => { paths?: Record<string, unknown> }) {
  const helpRouter = new Hono<AppBindings>();

  helpRouter.get("/guide/admin", (c) => {
    requireActor(c);
    return c.text(ADMIN_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/guide/auth", (c) => {
    return c.text(AUTH_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/guide/workers", (c) => {
    return c.text(WORKERS_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/guide/explorer", (c) => {
    return c.text(EXPLORER_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/guide/wiki", (c) => {
    return c.text(WIKI_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/guide", (c) => {
    return c.text(GENERAL_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/", (c) => {
    return c.text(renderIndexFromSpec(getSpec()), 200, TEXT_HEADERS);
  });

  helpRouter.get("/:method/:path{.+}", (c) => {
    const method = c.req.param("method").toUpperCase();
    const path = `/${c.req.param("path")}`;
    const body = renderRouteHelpFromSpec(getSpec(), method, path);
    if (!body) {
      return c.text(renderRouteNotFoundFromSpec(getSpec(), method, path), 404, TEXT_HEADERS);
    }
    return c.text(body, 200, TEXT_HEADERS);
  });

  return helpRouter;
}
