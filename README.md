# Arkeon Wiki

A knowledge graph that lives in your filesystem. Point it at a directory, and it watches for changes, indexes files into Postgres, and builds a connected graph from markdown links between them.

## Quick start

**1. Install and start**

```bash
npm install -g arkeon-wiki
arkeon-wiki start
```

First run downloads embedded Postgres (~50MB, cached). The daemon runs in the foreground — `Ctrl+C` to stop.

**2. Register a directory**

```bash
cd /path/to/my-knowledge-base
arkeon-wiki init
```

This registers the directory as a space. The daemon immediately starts watching it for changes.

**3. Add wiki files**

Create markdown files with YAML frontmatter under `wiki/`:

```markdown
---
label: Claude Shannon
subject_type: person
birth_year: 1916
---

Claude Shannon was the father of information theory.

He worked at [Bell Labs](../organization/bell-labs.md).
```

The system automatically:
- Detects new files and indexes them
- Generates stable IDs and writes them back to the frontmatter
- Resolves markdown links between files into relationship edges in Postgres
- Detects edits and re-syncs
- Detects deletions and cleans up

No manual sync commands. Just save files.

**4. Query the graph**

```bash
curl http://localhost:8000/entities              # list all entities
curl http://localhost:8000/entities/{id}          # get properties + relationships
curl http://localhost:8000/entities?type=wiki     # filter by type
```

## How it works

The filesystem is the source of truth. Postgres is an index.

- **Spaces** are directories registered with the daemon
- **Entities** are files on disk — wikis (under `wiki/`) have YAML frontmatter, everything else is a source file
- **Relationships** are standard markdown links (`[text](path.md)`) resolved into edges in Postgres
- A file watcher detects changes in real-time; a reconciliation pass on startup catches anything missed

## CLI

```bash
arkeon-wiki start              # start the daemon (Postgres + API)
arkeon-wiki stop               # stop it
arkeon-wiki status             # check if running
arkeon-wiki init [name]        # register current directory as a space
```

## Configuration

All state lives in `~/.arkeon-wiki/` (override with `ARKEON_WIKI_HOME`).

| Config | Purpose |
|--------|---------|
| `DATABASE_URL` env var | Use external Postgres instead of embedded |
| `ARKEON_WIKI_HOME` env var | Override state directory |
| `--port <port>` flag | API port (default: 8000) |
| `--pg-port <port>` flag | Embedded Postgres port (default: 5433) |

## Development

```bash
git clone https://github.com/Arkeon-Technologies/arkeon-wiki
cd arkeon-wiki
npm install
npx tsx packages/arkeon/src/index.ts start
```

### Testing

```bash
npm run typecheck -w packages/arkeon    # type checking
npm test -w packages/arkeon             # unit tests
npm run test:e2e -w packages/arkeon     # e2e tests (spins up its own Postgres)
```

## License

Apache License, Version 2.0. See [LICENSE](./LICENSE).
