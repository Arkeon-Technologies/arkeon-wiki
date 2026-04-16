# arkeon

A knowledge base that runs on your machine. Build a structured knowledge graph that transcends individual repositories — connecting concepts, patterns, and relationships across all of your code and documents.

<p align="center">
  <img src="https://raw.githubusercontent.com/Arkeon-Technologies/arkeon/main/docs/assets/explorer.png" alt="Arkeon Explorer — graph visualization and entity detail view" width="800" />
</p>

See the [full documentation](https://github.com/Arkeon-Technologies/arkeon) for details.

## Install

```bash
npm install -g arkeon
```

Requires Node.js 18.17+. No Docker, no external services.

## Quick start

```bash
arkeon init
arkeon up
```

Bind a repo to a space and register its documents:

```bash
arkeon init my-project
arkeon add README.md docs/
```

Repeat in other repos, then run `/arkeon-connect` to link them together.

Open [http://localhost:8000/explore](http://localhost:8000/explore) to see the graph.

## CLI

You can also use Arkeon directly from the command line:

```bash
arkeon init                # Generate secrets and state directory
arkeon up                  # Start the stack
arkeon status              # Check health
arkeon entities list       # List entities
arkeon search "query"      # Full-text search
arkeon down                # Stop
```

All API endpoints are available as CLI commands, auto-generated from the OpenAPI spec:

```bash
arkeon <resource> <action> [args]
```

## Configuration

```bash
export ARKE_API_URL="http://localhost:8000"
export ARKE_API_KEY="ak_..."
export ARKE_SPACE_ID="01ABC..."   # optional: default space
```

Override the state directory with `ARKEON_HOME` (default: `~/.arkeon/`).

## License

Apache-2.0
