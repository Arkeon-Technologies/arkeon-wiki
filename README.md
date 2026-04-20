# Arkeon Wiki

A knowledge graph that runs on your machine. Add documents, and Arkeon Wiki automatically extracts entities, drafts wiki pages, and builds a connected knowledge graph you can search, browse, and extend.

<p align="center">
  <img src="docs/assets/explorer.png" alt="Arkeon Wiki Explorer — graph visualization and entity detail view" width="800" />
</p>

## Quick start

**1. Install**

```bash
npm install -g arkeon-wiki
```

Requires Node.js 18.17+.

**2. Start the stack**

```bash
arkeon-wiki up
```

First run downloads embedded Postgres and Meilisearch (~100MB, cached after that). The admin API key is printed to the console.

**3. Configure the LLM**

The extraction and drafting workers need an LLM API key:

```bash
export OPENAI_API_KEY=sk-...
```

Works with any OpenAI-compatible API. For custom providers, create `~/.arkeon-wiki/llm.json`:

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

Restart the stack after setting the key: `arkeon-wiki down && arkeon-wiki up`

**4. Add documents**

```bash
cd /path/to/my-repo
arkeon-wiki init my-project       # bind this directory to a space
arkeon-wiki add README.md docs/   # add files to the knowledge graph
```

Files are automatically processed:
- **Extraction** — an LLM identifies notable subjects (people, concepts, places, etc.)
- **Drafting** — each subject gets a wiki page, cross-linked with other entities
- **Deduplication** — entities extracted from multiple documents are merged

Monitor progress:

```bash
arkeon-wiki watch
```

**5. Explore**

Open [http://localhost:8000/explore](http://localhost:8000/explore) to browse the graph, search entities, and traverse relationships.

## Using with Claude Code

Arkeon Wiki ships two skills for Claude Code:

```
/arkeon-wiki-doctor     # Set up, configure, and diagnose your installation
/arkeon-wiki-ingest     # Add files, monitor drafting, pull and edit wikis
```

The doctor skill walks you through first-time setup. The ingest skill handles the full workflow: add files, monitor extraction and drafting, pull results for editing, and re-add changes. Both are idempotent — safe to run repeatedly.

## How it works

1. **Add files** — `arkeon-wiki add` creates file entities and enqueues them for extraction
2. **Extract** — an LLM reads each document and identifies 5-30 notable subjects
3. **Draft** — each subject is drafted into a wiki page using context from the source document, related entities, and existing wikis
4. **Link** — wiki content uses `[[entity:ID]]` links that create typed relationships in the graph
5. **Cascade** — drafted wikis can reference new subjects via `[[assign:...]]` links, which are auto-queued for drafting

Re-adding a modified document triggers re-extraction, but only new subjects are extracted — previously extracted entities are preserved.

## Pull and edit

Download drafted wikis as editable markdown:

```bash
arkeon-wiki pull                  # download all wikis to wiki/{type}/{slug}.md
# edit the files...
arkeon-wiki add wiki/             # push changes back to the graph
```

Pulled wikis include YAML frontmatter with entity IDs and versions. Editing and re-adding re-runs the wiki pipeline (link resolution, relationship diffing) without creating duplicates.

## CLI reference

```bash
arkeon-wiki up                    # start the stack (background daemon)
arkeon-wiki down                  # stop the stack
arkeon-wiki status                # check health and configuration
arkeon-wiki watch                 # live queue monitoring dashboard

arkeon-wiki init [name]           # bind current directory to a space
arkeon-wiki add <paths...>        # add files to the graph
arkeon-wiki diff                  # show new/modified/deleted files
arkeon-wiki pull                  # download wikis as editable markdown
arkeon-wiki rm <paths...>         # remove files and cascade-delete entities

arkeon-wiki guide                 # getting started tutorial
arkeon-wiki docs                  # full CLI + API reference
arkeon-wiki docs --format api     # API reference (same as /llms.txt)
```

When the stack is running, the API is also self-documenting:

- [`/llms.txt`](http://localhost:8000/llms.txt) — full API reference for LLM context windows
- [`/openapi.json`](http://localhost:8000/openapi.json) — OpenAPI 3.1 spec
- [`/explore`](http://localhost:8000/explore) — graph explorer

## Configuration

All state lives in `~/.arkeon-wiki/` by default (override with `ARKEON_WIKI_HOME`).

| Config | Purpose |
|--------|---------|
| `OPENAI_API_KEY` env var | LLM API key (simplest setup) |
| `~/.arkeon-wiki/llm.json` | LLM provider, model, and per-step overrides |
| `~/.arkeon-wiki/workers.yaml` | Advanced: worker tuning, custom prompts, per-step models |
| `DATABASE_URL` env var | Use external Postgres instead of embedded |
| `MEILI_URL` / `MEILI_MASTER_KEY` | Use external Meilisearch |

See [Advanced Configuration](docs/ADVANCED.md) for the full schema.

## Development

```bash
git clone https://github.com/Arkeon-Technologies/arkeon-wiki
cd arkeon-wiki
npm install
npx tsx packages/arkeon/src/index.ts start    # foreground-attached stack
```

### Testing

```bash
npm run typecheck -w packages/arkeon   # type checking
npm test -w packages/arkeon            # unit tests
npm run test:e2e -w packages/arkeon    # e2e tests (needs running stack)
./scripts/test-local.sh               # full: typecheck + unit + start + e2e
```

## Documentation

### For users

| Document | Description |
|----------|-------------|
| [Quickstart](docs/user/QUICKSTART.md) | Detailed install, configuration, and lifecycle |

### For developers

| Document | Description |
|----------|-------------|
| [Architecture](docs/dev/ARCHITECTURE.md) | Package layout, request lifecycle, build pipeline |
| [Schema](docs/dev/SCHEMA.md) | Postgres tables, migrations, access control |
| [Context management](docs/dev/CONTEXT_MANAGEMENT.md) | How the API self-documents for LLMs |
| [Wiki pipeline](docs/dev/WIKI_PIPELINE.md) | Link resolution, entity extraction, drafting |

Design specs for planned features live in [docs/future/](docs/future/).

## License

Arkeon Wiki is licensed under the [Apache License, Version 2.0](./LICENSE). Arkeon is a trademark of Arkeon Technologies, Inc.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors must sign our CLA, which is handled automatically by a bot when you open your first pull request.

## Security

To report a security vulnerability, see [SECURITY.md](./SECURITY.md).
