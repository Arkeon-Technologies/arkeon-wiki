# Arkeon

<!-- arkeon:managed — do not remove this comment; arkeon install agents uses it to detect and update this file -->

Arkeon is a knowledge graph platform. It runs as a local server managing Postgres + Meilisearch, exposing a REST API for entities, relationships, spaces, and full-text/vector search.

## Quick Reference

- **API docs (for LLMs):** `curl http://localhost:8000/llms.txt`
- **Route help:** `curl http://localhost:8000/help/{method}/{path}` (e.g., `/help/get/entities/:id`)
- **OpenAPI spec:** `curl http://localhost:8000/openapi.json`
- **Status:** `npx arkeon status`

## CLI

The `arkeon` CLI manages the local stack and provides commands for all API operations:

```bash
npx arkeon --help          # List all commands
npx arkeon start           # Start the stack (Postgres + Meilisearch + API)
npx arkeon stop            # Stop the stack
npx arkeon status          # Show running state, URLs, and version
```

### Key workflows

- **Register documents:** `npx arkeon init <space>`, then `npx arkeon add <files>`
- **Search:** `npx arkeon search query --q "term" --space-id <id>`
- **Explore the graph:** Open the explorer URL from `npx arkeon status`
- **Cross-space linking:** Use the arkeon-connect skill/command to weave relationships across spaces

## Architecture

- Single Node.js process, no Docker required
- Embedded Postgres (via `embedded-postgres`) and Meilisearch binary
- State stored in `~/.arkeon/` (override with `ARKEON_HOME`)
- Spaces provide multi-tenant isolation; entities and relationships are scoped to spaces
- Classification levels (0-4) gate read access; write access requires level + ACL
