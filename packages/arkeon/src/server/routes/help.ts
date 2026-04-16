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
import { requireAdmin } from "../lib/http";
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

1. Create an entity
   POST /entities
   {
     "type": "note",
     "properties": { "title": "Hello", "body": "My first entity." }
   }
2. List entities
   GET /entities

3. Create a relationship
   POST /entities/{sourceId}/relationships
   {
     "predicate": "references",
     "target_id": "<entity B>",
     "properties": { "label": "references" }
   }

4. Search
   GET /search?q=hello

## Working Within a Space

Spaces are organizational containers with their own access controls. You can
add an entity to a space and grant permissions in the same call that creates it:

   POST /entities
   {
     "type": "note",
     "properties": { "title": "Hello" },
     "space_id": "<space ULID>",
     "permissions": [
       { "grantee_type": "actor", "grantee_id": "<actor ULID>", "role": "editor" }
     ]
   }

This is atomic — if any part fails (e.g. you lack contributor access on the
space), nothing is created. The same space_id and permissions fields work on
relationship creation (POST /entities/{id}/relationships).

You can still add entities to spaces and grant permissions separately:
   POST /spaces/{id}/entities          — add existing entity to space
   POST /entities/{id}/permissions     — grant permissions on existing entity

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

### SDK

Install:    npm install @arkeon-technologies/sdk
Usage:      import { ArkeonClient } from '@arkeon-technologies/sdk';
            const client = new ArkeonClient();
            await client.get('/entities');

The SDK reads ARKE_API_URL and ARKE_API_KEY from the environment and handles
authentication, pagination, and error handling automatically.

## Getting More Help

GET /help                         Full route index with auth & summary
GET /help/GET/entities/{id}       Detailed docs for any specific route
GET /help/guide/wiki              Authoring wikis with typed links
GET /help/guide/explorer          Explorer graph + screenshot server docs
GET /llms.txt                     Machine-readable route index
`;

const ADMIN_GUIDE = `# Arkeon — Admin Guide

This guide covers operations that require admin privileges.

## What Admins Can Do

- Create and manage networks, actors, and API keys
- Set classification levels on content
- Rebuild search indexes
- View instance-wide statistics

## Managing Actors

Create an actor:
  POST /actors
  {
    "kind": "agent",
    "properties": { "label": "Researcher" },
    "max_read_level": 2,
    "max_write_level": 2
  }

Generate an API key for them:
  POST /actors/{id}/keys

Only kind "agent" is supported. (Legacy "worker" actors from earlier
releases remain readable, but the runtime that invoked them has been
removed.)

## Classification Levels

Arkeon uses integer clearance levels (0-4) to control access:

  0  PUBLIC        readable by anyone, including unauthenticated
  1  INTERNAL      readable by any authenticated actor
  2  TEAM          requires TEAM clearance or above
  3  CONFIDENTIAL  requires CONFIDENTIAL clearance or above
  4  RESTRICTED    highly restricted

Entities have read_level and write_level.
Actors have max_read_level and max_write_level.

Rule: an actor can only read entities where
  entity.read_level <= actor.max_read_level
and only write where
  entity.write_level <= actor.max_write_level

## Spaces & Permissions

Create a space:
  POST /spaces
  { "name": "Design Review" }

Spaces have their own read_level/write_level defaults. Assign roles to
actors within spaces to scope access.

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
real relationships in the graph, so the wiki itself becomes a connective tissue
node — the more wikis you author, the richer the graph gets automatically.

Wikis are submitted via POST /wiki and published synchronously. The body is
validated, links are resolved, placeholders are minted for unresolved refs,
relationships are created, and the wiki is promoted from 'draft' to 'published'
all in one request.

## The four link types

All links use the \`[[ ... ]]\` form. Four types are supported:

  [[entity:ULID]]
      Hard reference to an existing visible entity. The unquoted ULID must
      resolve to an entity the actor can read; 404 otherwise. Redirects
      (entity_redirects table) are followed — the published content is
      rewritten to the canonical ID.

  [[resolve:"Label"|"Description"]]
      Ask the server to find a matching entity via Meilisearch candidate
      search + LLM-judged disambiguation. If a match is found, the link
      becomes an [[entity:ID]] reference. If not, a placeholder is minted
      (like [[draft:]]). Requires an LLM provider configured on the server;
      returns 503 \`llm_not_configured\` otherwise. The description is
      optional but sharply improves disambiguation quality.

  [[draft:"Label"|"Description"]]
      Mint a placeholder the author intends to flesh out later. The
      placeholder is queued in \`wiki_draft_queue\` for background drafting
      (a worker will eventually expand it into a real wiki). Use this when
      you're *promising* to cover something.

  [[gap:"Label"|"Description"]]
      Flag a named thing that *should* exist but doesn't, without committing
      to drafting it. The placeholder is visible in the graph as a gap node,
      so later authors can fill it in. Use this for "someone ought to write
      this" pointers.

Labels must be double-quoted. Description is optional but strongly recommended
for resolve/draft/gap — it gives the resolver (or a future drafter) context
beyond the bare label. Entity IDs are unquoted ULIDs.

## A worked example

POST /wiki
{
  "label": "Photosynthesis",
  "keywords": ["photosynthesis", "light reaction", "calvin cycle"],
  "short_description": "The process by which plants convert light energy into chemical energy.",
  "primary_entities": ["01HXYZ..."],        // the entity this wiki is about
  "content": "...see below..."
}

Body content:

  # Photosynthesis

  Photosynthesis converts light energy into chemical energy, primarily in
  the chloroplasts of [[entity:01ABC...]]. It has two stages: the light
  reactions (in the [[resolve:"Thylakoid Membrane"|"Site of the light reactions"]])
  and the [[resolve:"Calvin Cycle"|"The light-independent carbon fixation stage"]].

  ## Related concepts

  - [[draft:"Chlorophyll"|"The pigment that absorbs light in chloroplasts"]]
  - [[draft:"ATP Synthase"|"Enzyme that couples proton flow to ATP production"]]
  - [[gap:"Z-Scheme"|"The two-photosystem energy diagram used in most textbooks"]]

What happens:
  - The [[entity:01ABC...]] link resolves to a real chloroplast entity.
  - "Thylakoid Membrane" and "Calvin Cycle" go through resolve: candidate
    match + LLM judge. If the graph already has them, they link to the real
    entities. If not, placeholders are minted.
  - "Chlorophyll" and "ATP Synthase" become queued draft placeholders.
  - "Z-Scheme" becomes a gap placeholder (visible but not queued).
  - Every link becomes a \`references\` relationship from this wiki.
  - The primary_entity becomes an \`about\` relationship.

## How to choose between resolve, draft, and gap

  resolve  You know the thing exists or probably exists, and you want the
           server to connect it — even if the author doesn't know the ID.

  draft    You know the thing doesn't yet have a wiki, and you're promising
           to author one (or expecting a background worker to). Use when
           it's core to the topic.

  gap      You know the thing doesn't exist as a wiki, and you don't intend
           to write one. Use when it's worth flagging but out of scope.

## space_id

\`space_id\` is optional. If omitted, the server picks the single space the
actor can contribute to. If the actor has zero or multiple contributable
spaces, the server returns 400 — pass space_id explicitly in that case.

## Writing about link syntax inside a wiki

The parser scans every \`[[...]]\` pair in the content, including inside code
fences. To discuss link syntax in prose — like this very guide does — use
alternative delimiters (\`<<entity:id>>\`, or just describe the shape in
words). Do NOT write literal bracket pairs in prose; they will be parsed and
likely rejected as malformed.

## Errors

400 malformed_wiki_links     One or more links are syntactically wrong. The
                             error \`details\` array lists each offending link
                             with a reason and the correct syntax.
404 not_found                An [[entity:id]] link pointed at a non-existent
                             or invisible entity, or a primary_entity does.
409 wiki_exists              A wiki with overlapping primary_entities already
                             exists in the target space. Response includes
                             \`existing_wiki_id\` — update it, don't duplicate.
503 llm_not_configured       [[resolve:"..."]] links require an LLM provider.
                             Configure one with \`arkeon init --llm-*\` or set
                             OPENAI_API_KEY.
400 no_default_space         space_id omitted and the actor has no
                             contributable spaces. Create one first.
400 ambiguous_default_space  space_id omitted and the actor has more than one
                             contributable space. Pass space_id explicitly.

## See also

POST /resolve                    Standalone subject → candidate-matches primitive
GET  /entities/{id}              Read the published wiki as an entity
GET  /entities/{id}/relationships  See the materialized \`about\` and \`references\` edges
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
    requireAdmin(c);
    return c.text(ADMIN_GUIDE, 200, TEXT_HEADERS);
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
