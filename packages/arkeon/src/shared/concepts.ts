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
  An authenticated identity (kind='agent'). Each actor has API keys and
  clearance levels (max_read_level, max_write_level).`;

export const AUTHENTICATION = `\
Pass your API key via header:
  X-API-Key: <key>           (preferred)
  Authorization: ApiKey <key>

Key prefixes indicate type:
  uk_  user key
  kk_  klados key

Some routes are public; most require auth.`;

export const CLASSIFICATION_LEVELS = `\
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
  entity.write_level <= actor.max_write_level`;

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

Entity columns: kind, type, arke_id, ver, owner_id, read_level, write_level,
edited_by, created_at, updated_at

Property paths: label:Neuroscience, metadata.source:arxiv, year>2020`;
