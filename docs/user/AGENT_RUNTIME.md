# Agent runtime

arkeon-wiki ships a small AI agent runtime that lets you wire LLMs into the wiki without writing code. Built-in roles cover the common jobs (extracting subjects from sources, drafting wiki bodies); you tune their model, focus, and instructions in YAML and add your own custom roles when you need them.

This page is the from-scratch setup guide. If you only want to know what the runtime does, see [README.md](../../README.md).

## TL;DR

```bash
# 1. Install
npm install -g arkeon-wiki

# 2. Pick where your API key lives — anywhere on this list works.
mkdir -p ~/.arkeon-wiki && echo "OPENAI_API_KEY=sk-..." >> ~/.arkeon-wiki/.env
# (or)  echo "OPENAI_API_KEY=sk-..." >> .env       # in the current repo
# (or)  export OPENAI_API_KEY=sk-...               # in your shell profile

# 3. Bind a directory and configure agents
arkeon-wiki up
arkeon-wiki init                  # registers cwd as a space
arkeon-wiki config init           # writes .arkeon/agents.yaml from a template
$EDITOR .arkeon/agents.yaml       # set provider, model, instructions
arkeon-wiki config show           # confirm the merged effective config
```

## Where do my API keys go?

Three places, in increasing specificity. The most specific wins:

| Location | Use when |
|---|---|
| `~/.arkeon-wiki/.env` | **You have one OpenAI/Anthropic account and want it to work across every space.** Set once, forget. |
| `<your-repo>/.env` | Per-repo override. E.g., a work repo using a team-billed key vs. a personal repo on yours. |
| Shell env (`export OPENAI_API_KEY=…`) | One-off sessions, CI, secret managers (`OPENAI_API_KEY=$(op read ...) arkeon-wiki ...`). Wins over both files. |

`.env` files in your repo are gitignored automatically by `arkeon-wiki init`. The user-global `~/.arkeon-wiki/.env` is per-machine and never touched by git.

**API keys never go in YAML.** `.arkeon/agents.yaml` is committed to your repo so the team shares model choices and instructions; it must not contain secrets.

### Which environment variable to set

By default, arkeon-wiki looks up the standard env var per provider. You don't need to touch `api_key_env` in YAML for the common case.

| Provider in YAML | Env var read |
|---|---|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai-compatible` | `OPENAI_API_KEY` (most local/proxy servers reuse it) |

Override per role only when you genuinely need a different env var name (e.g. a separate Groq key alongside an OpenAI key):

```yaml
roles:
  fast-extractor:
    provider: openai-compatible
    base_url: https://api.groq.com/openai/v1
    api_key_env: GROQ_API_KEY      # only here because it's a different account
    model: llama-3.3-70b
```

## Configuration: `.arkeon/agents.yaml`

Run `arkeon-wiki config init` once per repo. It writes a fully-commented template you can edit:

```yaml
defaults:
  provider: openai             # openai | anthropic | openai-compatible
  model: gpt-5-mini

  # Operator notes appended to every role's system prompt. Use this to
  # steer subjects, tone, and scope without rewriting the workflow.
  instructions: |
    This wiki tracks researchers in climate science. Skip subjects
    not directly relevant to the field. Use British English.

# Per-role overrides. The built-in `ingestor` role is defined in the
# package and inherited automatically — fields you omit fall back to
# the built-in. Custom roles appear here too.
roles:
  ingestor:
    model: gpt-5-mini
    max_steps: 20
    instructions: |
      Each new wiki body is 2-4 paragraphs grounded in the source.
      Always include a markdown link from the wiki body back to the
      source path. Skip generic terms — only cover named subjects.

  link-checker:                # custom user-defined role
    provider: anthropic        # different provider per role is fine
    model: claude-opus-4-7
    api_key_env: ANTHROPIC_API_KEY
    tools: [list_wikis, read_file, edit_file]
    max_steps: 30
    system: |
      You find wikis with broken or missing cross-references and add
      markdown links to the wikis they should connect to. Use search
      and list_wikis to discover candidates.
    user: |
      Wiki to check: {{trigger_entity_id}}
```

### Config commands

```
arkeon-wiki config init               # create .arkeon/agents.yaml from template
arkeon-wiki config show               # print merged effective config
arkeon-wiki config validate           # schema-check the YAML
```

`config show` is the source of truth for "what is actually going to run" — it reflects the merged result of `~/.arkeon-wiki/agents.yaml`, `.arkeon/agents.yaml`, and the built-in templates.

### How merging works

| Section | Behavior when set in both global and repo |
|---|---|
| `defaults` | **Field-level merge.** `defaults.provider` from global + `defaults.model` from repo combine. Repo wins on shared fields. |
| `roles.<name>` | **Per-role replacement.** If `roles.ingestor` exists in both files, the repo entry replaces the global entry **wholesale** — fields you don't repeat are *not* inherited from the global. |

This asymmetry keeps role overrides predictable: when you write `roles.ingestor:` in your repo's YAML, you're declaring exactly what that role looks like for this repo, not partially patching whatever your `~/` happens to have.

To carry over a field from a global role override, copy it. The most common case is global YAML setting universal `defaults` and the per-repo file overriding individual roles — that works without copying anything because `defaults` *do* merge.

## Built-in roles

| Role | Tools | Job |
|---|---|---|
| `ingestor` | `read_file`, `list_wikis`, `search`, `write_file`, `edit_file` | Read a source file, identify the distinct subjects it discusses, and for each one either edit the existing wiki to weave the new material in (with a markdown link back to the source) or create a new wiki under `wiki/{subject_type}/{slug}.md` with a 2-4 paragraph body. |

You can override any field of the built-in (`provider`, `model`, `tools`, `max_steps`, `instructions`, `system`, `user`) without redefining the whole role. To inherit the workflow but bias the focus, set `instructions:` only.

Provenance: the `ingestor` writes a markdown link from each wiki body back to the source path it drew material from. The existing link-resolution path turns those into edges in the `relationships` table — so "which sources contributed to this wiki?" is a SQL query over `relationships`, not a separate inbox.

## Custom roles

Define a custom role by adding any name under `roles:` that isn't a built-in. Custom roles **must** specify:

- `system:` — the full system prompt (the workflow)
- `tools:` — list of tool names from the registry

Optional: `provider`, `model`, `api_key_env`, `base_url`, `max_steps`, `user` (template), `instructions`.

The available tools are:

| Tool | Use |
|---|---|
| `list_wikis` | Frontmatter-aware enumeration: filter by `subject_type`, `status`, `label_prefix`. |
| `search` | Keyword search via ripgrep, returns ranked entity hits with snippets. |
| `read_file` | Read a file's contents (markdown returns parsed frontmatter + body). |
| `write_file` | Net-new file (or full overwrite). |
| `edit_file` | SEARCH/REPLACE on an existing file (Aider-style; SEARCH must match exactly once). |

### Prompt template variables

Both `system:` and `user:` are templates. Available variables:

| Variable | Resolves to |
|---|---|
| `{{trigger_path}}` | The path that triggered this run (source file path, wiki path, etc.). Empty if the agent was invoked without a trigger. |
| `{{trigger_entity_id}}` | The entity id of the trigger. Empty if none. |
| `{{space_id}}` / `{{space_name}}` / `{{space_watch_dir}}` | The space the agent is running in. |
| `{{role_name}}` | The role being run. |

Unknown placeholders resolve to the empty string (no errors).

## Providers

| Provider | What it covers | Required fields |
|---|---|---|
| `openai` | Anything on `api.openai.com` (GPT-5, GPT-4o, etc.) | `model` |
| `anthropic` | Claude (Sonnet, Opus, Haiku) | `model` |
| `openai-compatible` | Ollama, LM Studio, llama.cpp `--server`, vLLM, OpenRouter, Groq, Together, Fireworks, DeepInfra — anything speaking the OpenAI chat-completions shape | `model`, `base_url` |

### Local Ollama

```yaml
defaults:
  provider: openai-compatible
  base_url: http://localhost:11434/v1
  model: llama3.1:70b
```

No API key needed. (Set `OPENAI_API_KEY=not-required` if Ollama complains.)

### OpenRouter (one key, hundreds of models)

```yaml
defaults:
  provider: openai-compatible
  base_url: https://openrouter.ai/api/v1
  model: anthropic/claude-sonnet-4-6
  api_key_env: OPENROUTER_API_KEY
```

Then put `OPENROUTER_API_KEY=sk-or-v1-…` in `~/.arkeon-wiki/.env`.

### Mixing providers per role

```yaml
defaults:
  provider: openai
  model: gpt-5-mini

roles:
  ingestor:                   # default ingestion on cheap OpenAI
    model: gpt-5-mini
  reviewer:                   # custom role on stronger Claude
    provider: anthropic
    model: claude-opus-4-7
    api_key_env: ANTHROPIC_API_KEY
    tools: [list_wikis, read_file, edit_file]
    system: |
      You review recently-edited wikis for clarity and citation quality...
  drafter:                    # local model for offline drafting
    provider: openai-compatible
    base_url: http://localhost:11434/v1
    model: llama3.1:70b
    tools: [list_wikis, read_file, write_file]
    system: |
      You draft wiki bodies offline...
```

Each role gets its own provider and key. Set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in `~/.arkeon-wiki/.env`; the local model needs no key.

## Verifying setup

A real-LLM smoke test ships with the package:

```bash
npm install -g arkeon-wiki    # if not already installed
# (with key set in ~/.arkeon-wiki/.env or shell)
arkeon-wiki up
arkeon-wiki init
arkeon-wiki config show       # confirm merged config
```

If you have the package source checked out:

```bash
npm run test:manual -w packages/arkeon
```

This runs the `ingestor` role against a synthetic source paragraph and prints the wikis that landed, token usage, and total cost.

## Troubleshooting

**`Required env var OPENAI_API_KEY is not set`**
Your YAML resolved to `provider: openai`, but no key was found. Drop one in `~/.arkeon-wiki/.env`, your repo's `.env`, or shell-export it.

**`Provider 'openai-compatible' requires base_url`**
You set `provider: openai-compatible` (often inherited from a default) but didn't set `base_url`. Either set it or change to `openai` / `anthropic`.

**`Role 'X': no system prompt`**
You defined a custom role but left out `system:`. Built-in roles fall back to a template; custom roles must supply their own.

**`Role 'X': no tools configured`**
Same idea — custom roles must specify `tools:`.

**Schema errors from `config validate`**
Check the unknown field name; the schema is strict. The likely candidates:
- `provider` accepts only `openai | anthropic | openai-compatible`
- `max_steps` must be a positive integer
- `tools` is an array of strings (tool names)

## What's not yet wired

- **Auto-triggering** — roles in YAML don't yet specify *when* they fire. The `ingestor` role will register on file events for sources outside `wiki/` once the daemon-side trigger lands. Until then, run it manually via the runtime API or the upcoming `arkeon-wiki agent run <role>` command.
- **Per-role budgets / cost caps** — set `max_steps` for now; spending caps are a planned follow-up.
- **Streaming output** — `runAgent` currently waits for the full response. Streaming will come with the daemon integration.
