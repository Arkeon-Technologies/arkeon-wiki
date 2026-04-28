# Arkeon Wiki

A knowledge graph that lives in your filesystem. Point it at a directory, and it watches for changes, indexes files into SQLite, and builds a connected graph from markdown links between them.

## Quick start

**1. Install and start**

```bash
npm install -g arkeon-wiki
arkeon-wiki up
```

This starts the daemon as a detached background process — it survives your terminal closing. Stop it with `arkeon-wiki down`. State (SQLite database, pidfile, log) lives in `~/.arkeon-wiki/`.

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
- Resolves markdown links between files into relationship edges in SQLite
- Detects edits and re-syncs
- Detects deletions and cleans up

No manual sync commands. Just save files.

**4. Query the graph**

```bash
curl http://localhost:8000/wikis                  # list wikis
curl http://localhost:8000/wikis/{id}             # get properties + relationships
curl "http://localhost:8000/wikis?subject_type=person&include=counts"
curl "http://localhost:8000/search?q=shannon"     # keyword search (ripgrep)
```

Or from the CLI: `arkeon-wiki search shannon`.

## How it works

The filesystem is the source of truth. SQLite is an index.

- **Spaces** are directories registered with the daemon
- **Entities** are files on disk — wikis (under `wiki/`) have YAML frontmatter, everything else is a source file
- **Relationships** are standard markdown links (`[text](path.md)`) resolved into edges in SQLite
- A file watcher detects changes in real-time; a reconciliation pass on startup catches anything missed

## CLI

```bash
arkeon-wiki up                 # start the daemon detached (SQLite + API)
arkeon-wiki down               # stop it
arkeon-wiki status             # check if running
arkeon-wiki ls                 # list running instances
arkeon-wiki logs [-f]          # print/tail the daemon log
arkeon-wiki init [name]        # register current directory as a space
arkeon-wiki search <query>     # keyword search (ripgrep, defaults to bound space)
arkeon-wiki config init        # write .arkeon/agents.yaml from a template
arkeon-wiki config show        # print merged effective agent config
arkeon-wiki config validate    # schema-check the YAML
arkeon-wiki start              # foreground (for use under pm2/launchd/etc.)
```

## Agents (LLM-powered)

arkeon-wiki ships a small AI agent runtime with built-in roles for extracting subjects from sources (`contributor`) and drafting wiki bodies (`editor`). Configure them in `.arkeon/agents.yaml` (committed) and put your API key in `~/.arkeon-wiki/.env` (per-user, machine-local).

```bash
arkeon-wiki config init                                       # template config
echo "OPENAI_API_KEY=sk-..." > ~/.arkeon-wiki/.env             # one key for all spaces
$EDITOR .arkeon/agents.yaml                                    # set provider/model/instructions
arkeon-wiki config show                                        # confirm what'll run
```

Roles run on OpenAI, Anthropic, or any OpenAI-compatible backend (Ollama, LM Studio, OpenRouter, Groq, vLLM, …). Each role can use a different provider; secrets stay in `.env`, never YAML. Custom user-defined roles are first-class.

Full setup guide: [docs/user/AGENT_RUNTIME.md](./docs/user/AGENT_RUNTIME.md).

## Configuration

All state lives in `~/.arkeon-wiki/` (override with `ARKEON_WIKI_HOME` or `--data-dir`).

| Config | Purpose |
|--------|---------|
| `ARKEON_WIKI_HOME` env var | Override state directory |
| `--data-dir <path>` flag | Per-invocation override |
| `--port <port>` flag | API port (default: 8000) |
| `--name <name>` flag | Run a named instance side-by-side with others |
| `~/.arkeon-wiki/.env` | Universal API keys (OpenAI, Anthropic, etc.) — auto-loaded |
| `<repo>/.env` | Per-repo API key override (gitignored by `init`) |
| `.arkeon/agents.yaml` | Per-repo agent config: providers, models, operator instructions, custom roles. Committed. See [AGENT_RUNTIME.md](./docs/user/AGENT_RUNTIME.md). |

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
npm run test:e2e -w packages/arkeon     # e2e tests (spins up SQLite + API in-process)
```

## License

Apache License, Version 2.0. See [LICENSE](./LICENSE).
