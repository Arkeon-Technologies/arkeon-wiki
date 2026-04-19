# Arkeon Connect

Discover and create relationships between entities across different spaces. `/arkeon-connect` weaves connections between spaces — linking the same person, concept, or work that appears in different corpora.

**Philosophy: be comprehensive.** It's better to over-connect than under-connect. Create all plausible connections, not just the obvious ones. Thin connections can always be pruned later, but missing connections are invisible.

## Prerequisites

This skill requires **admin** access to see all spaces. Before starting:

```bash
npx arkeon auth use admin
```

If there's no admin profile, set one up:
```bash
npx arkeon auth profiles
```

If "admin" is not listed, register the admin profile using the bootstrap key:

```bash
cat ~/.arkeon-wiki/secrets.json | grep admin_api_key   # find the key
npx arkeon auth set-api-key <key>                      # store it as your default key
npx arkeon auth add admin                              # create a named "admin" profile
```

## Workflow

### 1. Survey all spaces

List every space in the instance:

```bash
npx arkeon spaces list --limit 200
```

Note the space names and IDs. Report to the user:

> **Found {N} spaces:** {name1} ({id1}), {name2} ({id2}), ...

If there are fewer than 2 spaces, there's nothing to connect. Stop and explain.

### 2. Deep sample each space

For each space, build a thorough inventory of what it contains:

```bash
npx arkeon search query --q "*" --space-id {space_id} --limit 100
```

Also get high-connectivity entities that are likely connection hubs:

```bash
npx arkeon graph traverse --id {any_entity_id} --mode bridge --depth 2 --limit 50
```

For each space, note:
- All entity types and their counts
- Key entity labels (people, organizations, concepts, places, works)
- Predicates used
- Entities that appear frequently in relationships (hubs)

### 3. Generate space pairs and dispatch sub-agents

Enumerate all unique pairs of spaces: (A, B), (A, C), (B, C), etc. For N spaces this is N*(N-1)/2 pairs.

If `$ARGUMENTS` specifies a topic or entity name, filter to pairs where at least one space contains entities matching that topic.

Report the plan:

> **Connection plan:**
> - {N} spaces to survey
> - {P} space pairs to analyze
> - Dispatching sub-agents for parallel discovery

**Launch one sub-agent per space pair.** Send all Agent tool calls in a single message so they run concurrently. Each sub-agent's prompt must include:

1. The two space IDs and names
2. The sampled entity lists from step 2 for both spaces
3. The full connection protocol (steps a-g below)

### Sub-agent connection protocol

For your assigned space pair (Space A and Space B):

**a. Cross-search.** For every notable entity in Space A (people, organizations, concepts, places, works), search Space B:

```bash
npx arkeon search query --q "{entity_label}" --space-id {space_B_id} --limit 20
```

Then do the reverse: search Space A for every notable entity in Space B. Be exhaustive — search for every entity, not just the ones you think will match.

**b. Evaluate matches.** For each search hit, assess the connection:
- Same label and type: strong match, use `same_as`
- Similar label, same type: likely match, verify via description, use `same_as`
- Same concept, different labels (e.g., "De Civitate Dei" / "City of God"): use `same_as` with detail explaining the equivalence
- Thematic connection (e.g., "natural law" in legal vs. philosophical context): use `related_to`
- Influence or reference: use `influenced_by`, `references`, `preceded`, `part_of`

**c. Search descriptions.** Don't just match labels — read entity descriptions for references to entities in the other space that aren't captured by label matching:

```bash
npx arkeon entities get {id}
```

Look for mentions of people, works, concepts, or events from the other space.

**d. Create connection wikis.** For each group of connections between the two spaces, create a wiki page that links the entities together:

```bash
npx arkeon wiki create --label "Connections: {SpaceA} - {SpaceB}" \
  --subject-type "connection" \
  --keywords "cross-space,connections,{spaceA_name},{spaceB_name}" \
  --short-description "Cross-space relationships between {SpaceA} and {SpaceB}" \
  --content "## Cross-space connections

{Entity A label} in {SpaceA} is the same as [[entity:{ULID_IN_SPACE_B}]]: same person appearing in both spaces.

{Entity C label} in {SpaceA} is related to [[entity:{ULID_IN_SPACE_D}]]: thematic connection across corpora."
```

Key rules:
- Use `[[entity:ULID]]` links to reference existing entities by their IDs.
- Group connections into one or a few wiki pages per space pair.
- Describe each connection in prose — this becomes searchable context.
- Connection types to describe:
  - Same entity in different spaces (identity)
  - Thematic or conceptual connections
  - Influence, reference, or hierarchical connections
- Each `[[entity:ULID]]` link creates a `references` relationship automatically.

**e. Verify connections:**

**f. Enrich thin entities.** When you find the same entity in two spaces but one has a richer description, update the thinner one:

```bash
npx arkeon entities get {id}
npx arkeon entities update {id} --properties '{"description":"enriched description"}' --ver {ver}
```

**g. Report back** with: how many connections created, how many entities enriched, and a list of the connections found.

### 4. Cross-cutting synthesis (after all sub-agents complete)

After all pair-wise sub-agents finish, do a final synthesis pass yourself:

**a. Multi-space entities.** Identify entities that were connected across 3+ spaces. Search for them:

```bash
npx arkeon search query --q "{frequently_connected_entity}" --limit 50
```

If entity X was linked between spaces A-B and A-C, verify the B-C link exists too. Create it if missing.

**b. Thematic bridges.** Look for higher-order patterns across all spaces:
- Shared methodologies or frameworks
- Common time periods or events
- Cross-disciplinary concepts that unite multiple spaces
- People or organizations referenced across many spaces

Submit these as a final connection wiki.

**c. Second-order connections.** Check if connections created by sub-agents reveal new connections. For example, if Space A's "natural law" is linked to Space B's "lex naturalis", and Space B's "lex naturalis" is linked to Space C's "divine law", then Space A's "natural law" may relate to Space C's "divine law" too.

### 5. Report

After all connections are made, summarize:

> **Connect complete.**
> - Spaces surveyed: {N}
> - Space pairs analyzed: {P}
> - Cross-space relationships created: {R}
> - Entities enriched: {E}
> - Connection types: {breakdown by predicate}
> - Multi-space entities: {list of entities appearing in 3+ spaces}
>
> Notable connections:
> - {entity} links {space_a} and {space_b} via {predicate}
> - ...
