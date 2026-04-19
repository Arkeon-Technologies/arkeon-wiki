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

`arkeon init` generates secrets and a state directory at `~/.arkeon/`.
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

All state lives in `~/.arkeon/` (override with `ARKEON_HOME`):

```
~/.arkeon/
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

## What's next

- [API documentation](http://localhost:8000/llms.txt) — full API reference
  (also available at `/help` and `/openapi.json`)
- [TypeScript SDK](../dev/SDK.md) — lightweight HTTP client for building on the API
