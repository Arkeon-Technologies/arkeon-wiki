---
name: arkeon-connect
description: Find and create relationships between entities across different spaces in the graph.
disable-model-invocation: true
argument-hint: [topic or entity name]
allowed-tools: Bash(npx arkeon *, arkeon *, ls *), Read, Glob, Grep, Write
---

# Arkeon Connect

Discover and create relationships between entities across different spaces — linking the same person, concept, or work that appears in different corpora.

## Prerequisites

This skill requires **admin** access to see all spaces. Before starting:

```bash
npx arkeon auth use admin
```

If there's no admin profile, set one up:
```bash
npx arkeon auth profiles
```

If "admin" is not listed, you need the admin bootstrap key from the instance's `secrets.json`.

## Workflow

### 1. Survey all spaces

List every space in the instance:

```bash
npx arkeon spaces list --limit 200
```

Note the space names and IDs. Report to the user:

> **Found {N} spaces:** {name1} ({id1}), {name2} ({id2}), ...

If there are fewer than 2 spaces, there's nothing to connect. Stop and explain.

### 2. Sample each space

For each space, get a sense of what's in it:

```bash
npx arkeon search query --q "*" --space-id {space_id} --limit 30
```

Note the entity types, key labels, and predicates used. Build a mental model of what each space contains and where overlaps might exist.

### 3. Plan connections

Based on the survey, identify potential cross-space connections. Look for:

- **Same entity, different spaces** — e.g., "Augustine" appears in a theology space and a philosophy space. These should be linked (or merged if appropriate).
- **Referenced but not present** — e.g., a theology space mentions Plato but doesn't have a Plato entity, while a philosophy space does. Create a cross-space relationship.
- **Thematic connections** — e.g., a concept like "natural law" in a legal space relates to "natural law" in a philosophy space. These are conceptually linked even if the entities have different labels.
- **Temporal/causal chains** — e.g., events in one space that influenced events in another.

Report the plan to the user:

> **Connection plan:**
> - {N} entities appear in multiple spaces (candidates for linking)
> - {M} cross-space relationships to create
> - Spaces involved: {list}

If `$ARGUMENTS` specifies a topic or entity name, focus the search on that topic rather than doing a broad survey.

### 4. Search for matches

For each potential connection, search across spaces to find matching entities:

```bash
npx arkeon search query --q "{entity_label}" --limit 20
```

Note: omitting `--space-id` searches across ALL spaces. Compare results to find the same entity in different spaces.

When evaluating matches, consider:
- Same label and type → strong match
- Similar label, same type → likely match (verify via description)
- Same concept, different labels → use judgment (e.g., "De Civitate Dei" and "City of God")

### 5. Create cross-space relationships

For each confirmed connection, create a relationship. Use the Write tool to create an ops JSON file:

Write to `/tmp/arkeon-connect-ops.json`:
```json
{
  "format": "arke.ops/v1",
  "defaults": {},
  "ops": [
    {
      "op": "relate",
      "source": "01ENTITY_IN_SPACE_A",
      "target": "01ENTITY_IN_SPACE_B",
      "predicate": "same_as",
      "detail": "Same person appearing in both theology and philosophy corpora"
    }
  ]
}
```

Then submit:
```bash
npx arkeon ingest post-ops --data @/tmp/arkeon-connect-ops.json
```

Key rules:
- Use **bare ULIDs** for both source and target (they already exist).
- **No `source.entity_id`** on the envelope — you're not extracting from a document.
- **No `defaults.space_id`** — cross-space relationships don't belong to a single space. If you want the relationship edge itself to live in a specific space, set `space_id` on the relate op.
- Relationship predicates for cross-space links:
  - `same_as` — identical entity in different spaces
  - `related_to` — thematic or conceptual connection
  - `influenced_by`, `references`, `preceded` — directional connections
  - `part_of` — hierarchical connections
- Always include a `detail` field explaining the connection.

### 6. Enrich thin entities

When you find the same entity in two spaces but one has a richer description, consider updating the thinner one:

```bash
npx arkeon entities get {id}
```

Check the `ver` field, then update:
```bash
npx arkeon entities update {id} --properties '{"description":"enriched description"}' --ver {ver}
```

This is optional — only do it when one space has clearly more information about the entity than another.

### 7. Report

After all connections are made, summarize:

> **Connect complete.**
> - Spaces surveyed: {N}
> - Cross-space relationships created: {R}
> - Entities enriched: {E}
> - Connection types: {breakdown by predicate}
>
> Notable connections:
> - {entity} links {space_a} and {space_b} via {predicate}
> - ...
