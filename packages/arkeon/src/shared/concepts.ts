// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared concept definitions for the Arkeon platform.
 *
 * These are the single source of truth for "what things are" across
 * the API guide and CLI guide. They contain NO tool-specific examples
 * (no HTTP requests, no CLI commands).
 * Each consumer combines these with its own examples.
 */

export const WHAT_IS_ARKEON = `\
Arkeon is a knowledge graph API. You store entities (nodes) and relationships
(edges) in isolated networks. Everything is versioned, permissioned, and
searchable.`;

export const CORE_CONCEPTS = `\
Arke (Network)
  An isolated workspace. Actors belong to an arke — their data is automatically
  scoped to it. Admins can operate across arkes. List arkes with the arkes
  commands/endpoints.

Entity
  The fundamental data unit. Every entity has:
  - kind     "entity" or "relationship"
  - type     freeform semantic type (person, book, observation — your choice)
  - properties   JSON object for your data (label, body, metadata, etc.)
  Entities are versioned, commentable, and access-controlled.

Relationship
  A typed, directed edge between two entities. Relationships are themselves
  entities (kind: "relationship"), so they carry properties, versions, and
  comments just like any other entity.

Space
  An organizational container with its own access controls. Assign entities to
  spaces and grant actors roles within them.

Actor
  An authenticated identity (kind='agent'). Each actor has API keys.
  All authenticated actors have full read/write access.`;

export const AUTHENTICATION = `\
Pass your API key via header:
  X-API-Key: <key>           (preferred)
  Authorization: ApiKey <key>

Key prefixes indicate type:
  uk_  user key
  kk_  klados key

Some routes are public; most require auth.`;

export const BEST_PRACTICES = `\
Build a connected graph.
  Every entity should be connected to at least one other entity through a
  relationship. Isolated nodes are hard to discover and lose context. A good
  habit: when you create an entity, immediately create a relationship linking
  it to whatever prompted its creation — cite your sources.

Use relationships, not properties, for references.
  If entity A references entity B, create a relationship between them rather
  than storing B's ID inside A's properties. Relationships are first-class:
  they're searchable, permissioned, and visible in the graph. A property
  value is just opaque text.

Relationships are entities too.
  Because relationships are full entities (kind: "relationship"), they can
  carry their own properties, versions, and comments — and other entities can
  relate to them. This means you can cite a relationship, annotate it, or
  build second-order structure (e.g., "this claim is supported by that
  relationship").`;

export const FILTERING_HINT = `\
Any listing endpoint supports the filter query param.
Format: filter=field<op>value,field<op>value (comma-separated, AND'd)

Operators: : (equals), !: (not equals), > >= < <= (comparisons), ? (exists), !? (missing)

Entity columns: kind, type, arke_id, ver, owner_id,
edited_by, created_at, updated_at

Property paths: label:Neuroscience, metadata.source:arxiv, year>2020`;

export const AUTH_PROFILES = `\
Profiles are per-repo actor identities bound to an Arkeon instance. Each
profile maps to an actor on the graph and carries its own API key.

Switching profiles changes the active actor for the current repo — all
subsequent operations run as that actor with its permissions.

Adding a profile creates a new actor on the graph and registers it locally.
This requires admin privileges. The admin profile is needed for cross-space
operations and actor management.

Profiles are stored in the instance actor registry, keyed by the instance
host and port. Multiple repos can share profiles for the same instance.`;

export const INSTANCES = `\
Named instances allow running multiple isolated Arkeon stacks on one machine.
Pass a name on startup and the instance gets its own state directory under
~/.arkeon-wiki/<name>/ — separate database, search index, secrets, and config.

Ports are automatically assigned to avoid conflicts. The instance registry at
~/.arkeon-wiki/instances/<port>.json tracks each running stack so the CLI can
discover and manage them.

The default (unnamed) instance uses ~/.arkeon-wiki/ directly.`;

export const WORKERS = `\
Worker configuration lives in ~/.arkeon-wiki/workers.yaml (override the path
with ARKEON_WORKERS_CONFIG).

The top-level llm block sets global LLM defaults: provider, api_key, model,
base_url, and max_tokens. These apply to every worker unless overridden.

Individual workers are configured under the workers key. Currently implemented:
  extractor    Parses raw documents into entities and relationships
  drafter      Generates wiki articles from graph neighborhoods

Planned (not yet implemented):
  consolidator Merges duplicate entities
  connector    Discovers missing relationships

Each worker supports: enabled (boolean), llm overrides (same fields as the
global block), prompt_mode (replace, prepend, or append), and prompt (custom
text). Background workers (drafter, consolidator) also accept poll_interval
(duration strings like 10s, 5m) and batch_size.

The extractor supports per-step overrides under a steps key (e.g., resolve,
exists) for fine-grained control over individual extraction stages.

Resolution priority: step config > worker llm > global llm > hardcoded
defaults. The legacy llm.json file still works as the lowest-priority
fallback.`;
