# Arkeon Wiki

A knowledge graph that lives in your filesystem. Point it at a directory, and it watches for changes, indexes files into SQLite, and builds a connected graph from `<a href>` links between HTML articles.

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

Create HTML articles under `wiki/`:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Claude Shannon</title>
  <meta name="label" content="Claude Shannon">
  <meta name="short_description" content="The mathematician who founded information theory.">
</head>
<body>
  <h1>Claude Shannon</h1>
  <p>Claude Shannon was the father of information theory.</p>
  <p>He worked at <a href="bell-labs.html">Bell Labs</a>.</p>
</body>
</html>
```

The system automatically:
- Detects new files and indexes them by `(space_name, source_path)` — no IDs
- Extracts `<title>` + `<meta>` tags into searchable properties
- Resolves `<a href>` links into relationship edges
- Detects edits and re-syncs
- Detects deletions and cleans up

No manual sync commands. Just save files.

**4. Read in the browser**

Open `http://localhost:8000/` to see the list of registered spaces. Click through to an article — the daemon serves the HTML straight off disk, injects a small back-link strip, and tags missing link targets in red so red links are obvious as you read.

URL structure mirrors disk structure within a space (`wiki/foo.html` on disk → `http://localhost:8000/{space}/wiki/foo.html`). Relative hrefs in articles resolve the same way over HTTP and `file://`, so the writer's output stays portable — copy the directory, open the HTML, links work.

**5. Query the graph**

```bash
# List wikis in your space
curl "http://localhost:8000/{space}/entities?type=wiki"

# Get one article with relationships
curl "http://localhost:8000/{space}/entities/wiki/photosynthesis.html"

# Find link targets that don't have an article yet ("red links")
curl "http://localhost:8000/{space}/redlinks"

# Keyword search via ripgrep
curl "http://localhost:8000/{space}/search?q=shannon"
```

Or from the CLI: `arkeon-wiki search shannon`.

## How it works

The filesystem is the source of truth. SQLite is an index.

- **Spaces** are directories registered with the daemon (keyed by name).
- **Entities** are files on disk, identified by `(space_name, source_path)`. HTML files under `wiki/` are `type='wiki'`; anything else is `type='file'`.
- **Relationships** are `<a href>` links resolved into edges. A link to a target without a matching entity is a **red link** — surfaced via `/{space}/redlinks` for the writer to fill in.
- A file watcher detects changes in real-time; a reconciliation pass on startup catches anything missed.

## CLI

```bash
arkeon-wiki up                 # start the daemon detached (SQLite + API)
arkeon-wiki down               # stop it
arkeon-wiki status             # check if running
arkeon-wiki ls                 # list running instances
arkeon-wiki logs [-f]          # print/tail the daemon log
arkeon-wiki init [name]        # register current directory as a space
arkeon-wiki search <query>     # keyword search (ripgrep, defaults to bound space)
arkeon-wiki sources scan       # list files by extension (supported vs unsupported)
arkeon-wiki agent run <role>   # fire one role on demand (writer/editor/proposer/custom)
arkeon-wiki config init        # write .arkeon/agents.yaml from a template
arkeon-wiki config show        # print merged effective agent config
arkeon-wiki config validate    # schema-check the YAML
arkeon-wiki start              # foreground (for use under pm2/launchd/etc.)
```

## Agents (LLM-powered)

arkeon-wiki ships a three-role agent pipeline — `editor`, `proposer`, `writer` — that ingests sources, proposes the questions worth answering, and drafts the HTML articles. All three run on cron, serialized per-space. `arkeon-wiki init` lays down `.arkeon/agents.yaml` from the bundled `wiki` template (committed so the team shares it); secrets go in `~/.arkeon-wiki/.env` (per-user, machine-local).

```bash
echo "OPENAI_API_KEY=sk-..." > ~/.arkeon-wiki/.env             # one key for all spaces
$EDITOR .arkeon/agents.yaml                                    # set provider/model/instructions
arkeon-wiki config show                                        # confirm what'll run
```

`init` skips the template if `.arkeon/agents.yaml` already exists. To re-create one (or pick a different template later) run `arkeon-wiki config init --template <name>` (use `--force` to overwrite).

Roles run on OpenAI, Anthropic, or any OpenAI-compatible backend (Ollama, LM Studio, OpenRouter, Groq, vLLM, …). Each role can use a different provider; secrets stay in `.env`, never YAML. Custom user-defined roles are first-class.

### Opinionating your wiki

A bare config will produce a generic wiki that takes every source seriously and writes articles on whatever it finds. To get an *opinionated* wiki — one with a point of view, a scope, a house style — set `instructions:` in `.arkeon/agents.yaml`. It's appended to every role's system prompt without disturbing the workflow, so it's the one knob you reach for first.

```yaml
defaults:
  instructions: |
    This wiki is about distributed systems, with a bias toward
    primary-source engineering writeups (postmortems, design docs,
    papers) over secondary commentary. Skip vendor blog posts.
    Tone: skeptical, evidence-led, no marketing voice.
    Audience: practitioners, not students — assume the reader knows
    what consensus and replication are.
```

This is the most consequential setting in the file. The default article structure (`Question / Current answer / Evidence / Open threads`) is a soft convention baked into the bundled prompts — if it doesn't fit your domain, override the `writer` role's `system:` directly. Otherwise, treat `instructions:` as the place to spend your editorial judgment.

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
| `<repo>/.env` | Per-repo API key override. Gitignored by `init` (alongside `.arkeon/state.json`). |
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
