# Quickstart

Get a knowledge graph running locally in under two minutes.

## Prerequisites

Node.js 18.17 or later. That's it.

## Install and run

```bash
npm install -g arkeon
arkeon init
arkeon up
```

`arkeon init` generates secrets and a state directory at `~/.arkeon-wiki/`.
`arkeon up` starts embedded Postgres, Meilisearch, and the API as a
background daemon. First run downloads a Meilisearch binary (~100 MB) —
cached after that.

## Load demo data

```bash
arkeon seed
```

Seeds a few Genesis demonstration wiki pages that showcase the wiki pipeline,
including placeholder links that automatically create stub entities.

## Explore

- **Graph explorer**: [http://localhost:8000/explore](http://localhost:8000/explore)
- **API**: [http://localhost:8000](http://localhost:8000)
- **Health check**: [http://localhost:8000/health](http://localhost:8000/health)

The CLI is already authenticated as the bootstrap admin:

```bash
arkeon status              # Stack health
arkeon entities list       # List entities
arkeon search "philosophy" # Full-text search
```

## Lifecycle commands

| Command | What it does |
|---------|-------------|
| `arkeon up` | Start as background daemon |
| `arkeon down` | Stop daemon (preserves data) |
| `arkeon start` | Foreground-attached (Ctrl+C to stop) |
| `arkeon status` | Check if running |
| `arkeon reset` | Wipe data, keep secrets + binaries |
| `arkeon reset --hard` | Wipe everything |

## State directory

All state lives in `~/.arkeon-wiki/` (override with `ARKEON_WIKI_HOME`):

```
~/.arkeon-wiki/
  bin/meilisearch       # downloaded once
  data/postgres/        # embedded Postgres cluster
  data/meili/           # Meilisearch index
  data/files/           # uploaded files (local storage)
  secrets.json          # admin key, encryption key, PG password
  arkeon.pid / .log     # daemon pidfile + log
```

## Bring your own Postgres / Meilisearch

For production or managed infrastructure:

```bash
export ARKEON_DATABASE_URL=postgresql://arke_app:PASSWORD@db.example.com:5432/arke
export ARKE_APP_PASSWORD=PASSWORD
export ARKEON_MEILI_URL=https://ms-xxxx.meilisearch.io
export ARKEON_MEILI_MASTER_KEY=...
arkeon up
```

Embedded services are skipped when external URLs are set. Migrations
still run on startup.

## Working with wikis

### Creating wikis via the CLI

Create a wiki entity directly:

```bash
arkeon wiki create --label "Claude Shannon" --type person \
  --body "Father of information theory."
```

### The pull-edit-push workflow

Pull entities to disk as Markdown files with YAML frontmatter, edit
locally, then push changes back:

```bash
arkeon pull "information theory"    # downloads matching entities to wiki/
# edit the files in wiki/ with your editor
arkeon diff                         # see what changed
arkeon add wiki/                    # push edits back to the graph
```

Pulled files include `id` and `ver` in their frontmatter. The `ver`
field enables optimistic concurrency — the server rejects updates if
someone else modified the entity since you pulled it.

### Adding raw documents

Add Markdown, text, or LaTeX files without frontmatter. The wiki
pipeline extracts entities and relationships automatically:

```bash
arkeon add papers/          # ingest all documents in papers/
arkeon add notes.md         # ingest a single file
```

## Configuration priority

### Space selection

When multiple spaces exist, the active space resolves in this order:

1. `ARKE_SPACE_ID` environment variable
2. `.arkeon/state.json` `space_id` (per-repo, set by `arkeon init`)
3. `arkeon config set-space` (global default)

### Authentication

API key resolution order:

1. `ARKE_API_KEY` environment variable
2. Per-repo actor key (from `.arkeon/state.json` actors + instance registry)
3. Global credential store (`~/.config/arkeon-cli/credentials.json`)

For most local usage, `arkeon init` sets up the per-repo actor key
automatically and you never need to think about this.

## What's next

- [API documentation](http://localhost:8000/llms.txt) — full API reference
  (also available at `/help` and `/openapi.json`)
- [TypeScript SDK](../dev/SDK.md) — lightweight HTTP client for building on the API
