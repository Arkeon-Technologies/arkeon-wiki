# Quickstart

Get a knowledge graph running locally in under five minutes.

## Prerequisites

Node.js 18.17 or later. An OpenAI-compatible API key for the extraction and drafting workers.

## Install and start

```bash
npm install -g arkeon-wiki
arkeon-wiki up
```

`arkeon-wiki up` starts embedded Postgres, Meilisearch, and the API as a background daemon. First run downloads a Meilisearch binary (~100 MB) and initializes the database — cached after that.

The admin API key is printed on first start and saved to `~/.arkeon-wiki/secrets.json`.

## Configure LLM

The extraction and drafting workers need an LLM API key. Set the environment variable before starting:

```bash
export OPENAI_API_KEY=sk-...
arkeon-wiki down && arkeon-wiki up    # restart to pick up the key
```

This works with any OpenAI-compatible API (OpenAI, Anthropic via proxy, Ollama, LM Studio, etc.).

For more control, create `~/.arkeon-wiki/llm.json`:

```json
{
  "default": {
    "provider": "openai",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-4o"
  }
}
```

Per-step model overrides (resolve, draft, etc.) and advanced worker configuration are available via `~/.arkeon-wiki/workers.yaml` — see [Advanced Configuration](../ADVANCED.md).

## Add documents

Bind a directory to a space and add files:

```bash
cd /path/to/my-repo
arkeon-wiki init my-project       # bind this directory to a space
arkeon-wiki add README.md docs/   # add files to the knowledge graph
```

Each directory gets its own space. Supported formats: `.md`, `.txt`, `.tex`, `.rst`, `.adoc`, `.org`.

## Monitor progress

Files are processed asynchronously. Watch the extraction and drafting queues:

```bash
arkeon-wiki watch
```

This shows a live dashboard with queue counts, currently processing items, and recent completions. The pipeline:

1. **Extract** — LLM identifies notable subjects in each document (people, concepts, places, etc.)
2. **Draft** — each subject gets a wiki page, cross-linked with other entities
3. **Cascade** — drafted wikis can reference new subjects, which are auto-queued for drafting

Extraction is idempotent — re-adding a modified document only extracts new subjects.

## Explore

- **Graph explorer**: [http://localhost:8000/explore](http://localhost:8000/explore)
- **API**: [http://localhost:8000](http://localhost:8000)
- **Health check**: [http://localhost:8000/health](http://localhost:8000/health)

```bash
arkeon-wiki status                # stack health + configuration
```

## Pull and edit wikis

Download drafted wikis as editable markdown:

```bash
arkeon-wiki pull                  # downloads wikis to wiki/{type}/{slug}.md
```

Each file has YAML frontmatter with `id` and `ver` fields. Edit the markdown, then push changes back:

```bash
arkeon-wiki diff                  # see what changed
arkeon-wiki add wiki/             # push edits back to the graph
```

The wiki pipeline re-runs automatically — links are resolved, relationships are diffed and updated. The `ver` field enables optimistic concurrency (the server rejects updates if someone else modified the entity since you pulled it).

## Load demo data

```bash
arkeon-wiki seed
```

Seeds Genesis demonstration wiki pages that showcase the wiki pipeline, including placeholder links that automatically create stub entities. Useful for testing before adding your own content.

## Lifecycle commands

| Command | What it does |
|---------|-------------|
| `arkeon-wiki up` | Start as background daemon |
| `arkeon-wiki down` | Stop daemon (preserves data) |
| `arkeon-wiki start` | Foreground-attached (Ctrl+C to stop) |
| `arkeon-wiki status` | Check health and configuration |
| `arkeon-wiki watch` | Live queue monitoring dashboard |
| `arkeon-wiki reset` | Wipe data, keep secrets + binaries |
| `arkeon-wiki reset --hard` | Wipe everything |

## State directory

All state lives in `~/.arkeon-wiki/` (override with `ARKEON_WIKI_HOME`):

```
~/.arkeon-wiki/
  bin/meilisearch       # downloaded once
  data/postgres/        # embedded Postgres cluster
  data/meili/           # Meilisearch index
  data/files/           # uploaded files (local storage)
  secrets.json          # admin key, encryption key, PG password
  llm.json              # LLM configuration (optional)
  workers.yaml          # advanced worker config (optional)
  arkeon.pid / .log     # daemon pidfile + log
```

## Bring your own Postgres / Meilisearch

For production or managed infrastructure:

```bash
export DATABASE_URL=postgresql://arke_app:PASSWORD@db.example.com:5432/arke
export MEILI_URL=https://ms-xxxx.meilisearch.io
export MEILI_MASTER_KEY=...
arkeon-wiki up
```

Embedded services are skipped when external URLs are set. Migrations still run on startup.

## Configuration priority

### Space selection

When multiple spaces exist, the active space resolves in this order:

1. `ARKE_SPACE_ID` environment variable
2. `.arkeon/state.json` `space_id` (per-repo, set by `arkeon-wiki init`)

### Authentication

API key resolution order:

1. `ARKE_API_KEY` environment variable
2. Per-repo actor key (from `.arkeon/state.json` actors + instance registry)
3. Global credential store (`~/.config/arkeon-cli/credentials.json`)

For most local usage, `arkeon-wiki init` sets up the per-repo actor key automatically.

## Using with Claude Code

If you use Claude Code, two skills handle the full workflow:

```
/arkeon-wiki-doctor     # first-time setup, health checks, LLM config
/arkeon-wiki-ingest     # add files, monitor drafting, pull and edit
```

## What's next

- [API documentation](http://localhost:8000/llms.txt) — full API reference (also at `/help` and `/openapi.json`)
- [Advanced Configuration](../ADVANCED.md) — worker tuning, custom prompts, per-step models
