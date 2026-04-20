# Arkeon Wiki

<!-- arkeon:managed — do not remove this comment; arkeon-wiki install agents uses it to detect and update this file -->

Arkeon Wiki is a knowledge graph that runs locally. It manages embedded Postgres + Meilisearch, exposes a REST API, and includes extraction/drafting workers that automatically build wiki pages from documents.

## Quick Reference

- **API docs (for LLMs):** `curl http://localhost:8000/llms.txt`
- **Route help:** `curl http://localhost:8000/help/{method}/{path}` (e.g., `/help/get/wiki/:id`)
- **OpenAPI spec:** `curl http://localhost:8000/openapi.json`
- **Status:** `arkeon-wiki status`
- **Explorer:** `http://localhost:8000/explore`

## Skills

Two skills are available for Claude Code, Codex, and Cursor:

- `/arkeon-wiki-doctor` — Set up, configure, and diagnose the installation (stack, LLM config, health)
- `/arkeon-wiki-ingest` — Add files, monitor extraction/drafting, pull and edit wikis

## CLI

The `arkeon-wiki` CLI manages the local stack and all API operations:

```bash
arkeon-wiki up                    # start the stack (background daemon)
arkeon-wiki down                  # stop the stack
arkeon-wiki status                # health, URLs, configuration
arkeon-wiki watch                 # live queue monitoring dashboard
```

### Key workflows

- **Add documents:** `arkeon-wiki init <space>`, then `arkeon-wiki add <files>`
- **Monitor drafting:** `arkeon-wiki watch` — shows extraction and drafting queue progress
- **Pull and edit:** `arkeon-wiki pull` → edit markdown → `arkeon-wiki add wiki/`
- **Search:** `arkeon-wiki search query --q "term"`
- **Explore:** open the explorer URL from `arkeon-wiki status`

## Architecture

- Single Node.js process, no Docker required
- Embedded Postgres and Meilisearch binary (downloaded on first run)
- State stored in `~/.arkeon-wiki/` (override with `ARKEON_WIKI_HOME`)
- LLM workers extract entities from documents and draft wiki pages automatically
- Spaces provide multi-tenant isolation; entities and relationships are scoped to spaces
- Requires `OPENAI_API_KEY` or `~/.arkeon-wiki/llm.json` for extraction/drafting
