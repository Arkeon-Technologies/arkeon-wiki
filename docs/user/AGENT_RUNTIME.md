# Agent runtime

arkeon-wiki ships a small AI agent runtime that lets you wire LLMs into the wiki without writing code. Bundled roles cover the common jobs (integrating sources, proposing questions, drafting articles); you tune their model, focus, and instructions in YAML and add your own custom roles when you need them.

This page is the setup guide. If you only want to know what the runtime does, see [README.md](../../README.md).

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

## How the runtime works

Three things to know:

1. **Roles run on cron.** Each role declares a cron expression and the scheduler fires it on that cadence. There is no queue, no file-watcher dispatch, no event bus — when a tick fires, the role surveys current state via its tools and decides what to do.

2. **One role at a time per space.** A per-space mutex serializes role runs. If a tick fires while another role is already running in the same space, the tick is skipped (skip-if-busy) and the next firing is scheduled from "now." Different spaces run in parallel.

3. **Roles are LLMs with tools.** A role is a system prompt plus a whitelist of tools (read, search, edit, create, tag). Each run is a Vercel AI SDK loop: the model calls tools, the runtime executes them, the result feeds back in, until the model emits a final reply or hits `max_steps`.

Roles ship as YAML templates inside the package and are loaded fresh on every run. Your `.arkeon/agents.yaml` layers on top: any field you set there overrides the template's value; anything you omit falls through to the template.

## Bundled roles

The package ships three roles that compose into a question-driven wiki pipeline. You can run all three, run a subset, or replace them entirely.

| Role | Job |
|---|---|
| `editor` | Integrates each new source into existing articles. Adds citation-bearing paragraphs to Evidence sections; revises a thesis when a source reshapes it; adds open-thread red links for questions the source raises. Never creates new articles. |
| `proposer` | After the editor has handled a source, identifies the questions the editor did *not* integrate and emits them as red links in a per-source plan wiki (`wiki/_plans/<source-slug>.html` with `<meta name="kind" content="plan">`). Never edits existing articles or writes article bodies — only red-link slugs. |
| `writer` | Drains the red-link queue. Picks the highest-demand red link, follows it back to the articles and plan wikis that point at it, reads the cited sources, and creates the target article. Never edits existing articles. |

The three roles run on cron and coordinate via tags on source files (`editor.processed_hash`, `proposer.processed_hash`) — when an editor finishes a source, the proposer's next tick sees it as queue-ready. There's no message-passing; each role re-derives its work from current state.

Default cadences (set in each role's template):

| Role | Cron |
|---|---|
| `editor` | hourly |
| `proposer` | hourly (gates on editor's tag, so naturally trails one cycle) |
| `writer` | every 15 minutes |

**Cost note.** All three bundled templates default to `gpt-5.4-mini` with `reasoning_effort: low`. A fresh `arkeon-wiki up` against a populated corpus with `OPENAI_API_KEY` set will start spending API credit within 15 minutes. To inspect behavior before letting them run, override the cadence per role in `.arkeon/agents.yaml` (e.g. an off-hours cron, or a far-future schedule while you experiment).

## Configuration: `.arkeon/agents.yaml`

### Opinionating your wiki via `instructions:`

The single most consequential field in this file is `defaults.instructions:`. It's appended to every role's system prompt and is the way you give the wiki a point of view — what it's about, what it's not about, what tone, what audience. Without it, the agents produce a generic wiki that takes every source at face value. With it, the corpus develops editorial judgment.

```yaml
defaults:
  instructions: |
    This wiki is about <topic>, with a bias toward <preferred source
    types> over <deprioritized source types>. Skip <out-of-scope
    subjects>. Tone: <voice>. Audience: <reader profile> — assume
    they already know <prerequisite knowledge>.
```

Treat `instructions:` as the place you spend your editorial judgment. The bundled role workflows are deliberately generic; `instructions:` is where you make them yours. If even that isn't enough — e.g. you want a different article structure entirely — override the role's `system:` directly. But reach for `instructions:` first; it leaves the validated workflow intact.

### The template `config init` writes

`arkeon-wiki config init` drops a fully-commented `.arkeon/agents.yaml` into the current repo. Out of the box the only thing it sets is `defaults.provider` and `defaults.model` plus a commented-out `instructions:` block to fill in. Everything else (per-role tool whitelists, prompts, cron expressions) inherits from the bundled templates until you override it.

Edit the file, then run `arkeon-wiki config show` to see the merged effective config.

### Three tiers of customization

Pick the lightest one that does what you need.

**1. Defaults that apply to every role.** Anything under `defaults:` propagates to all roles — bundled and custom alike — unless the role overrides the field. Most operators only need this tier:

```yaml
defaults:
  provider: openai
  model: gpt-5-mini
  instructions: |
    This wiki is about distributed systems. Skip vendor marketing.
```

**2. Per-role field overrides.** Under `roles.<name>:`, override only the fields you care about. Field-level inheritance from the template means you can swap a model without re-supplying the prompt, or extend the prompt with extra `instructions:` without rewriting the workflow:

```yaml
roles:
  writer:
    model: gpt-5                  # stronger model just for the writer
    cron: "0 */2 * * *"           # every 2 hours instead of every 15 min
    instructions: |
      Lean toward shorter articles. Two paragraphs of Evidence is enough.
  editor:
    reasoning_effort: medium      # spend more thinking on integrations
```

**3. Custom roles.** Add a role name that isn't bundled and the runtime treats it as user-defined. Custom roles must supply at minimum `system:`, `tools:`, and `cron:`:

```yaml
roles:
  curator:
    provider: anthropic
    model: claude-opus-4-7
    api_key_env: ANTHROPIC_API_KEY
    tools: [list_entities, read_file, search, edit_file]
    max_steps: 30
    cron: "0 4 * * *"             # daily at 04:00
    system: |
      You find articles whose theses no longer match their evidence and
      rewrite the thesis. Read the article, scan the cited sources, decide
      whether the Current Answer still holds, and if not, str_replace the
      thesis paragraph.
```

A custom role without `cron:` is template-only and won't auto-fire — that's how you keep a role checked into the YAML for documentation while disabling it.

### Available fields

Every field is optional unless your role is custom (in which case `system:`, `tools:`, and `cron:` are required for it to auto-run).

| Field | What it controls |
|---|---|
| `provider` | `openai`, `anthropic`, or `openai-compatible`. |
| `model` | Model name passed to the provider. |
| `api_key_env` | Override which env var the runtime reads. Defaults to the standard per-provider name. |
| `base_url` | Required for `openai-compatible`; ignored otherwise. |
| `tools` | List of tool names from the registry (see below). |
| `max_steps` | Per-tick cap on tool-call iterations. |
| `reasoning_effort` | `minimal` \| `low` \| `medium` \| `high`. OpenAI-only; silently ignored for other providers. |
| `system` | Full system prompt. Replaces the template's prompt entirely. Use sparingly — `instructions:` is usually enough. |
| `user` | First user message template. Variables: `{{space_name}}`, `{{space_watch_dir}}`, `{{trigger_path}}`, `{{role_name}}`. |
| `instructions` | Operator notes appended to whatever `system` resolves to. The recommended customization knob. |
| `phases` | Multi-phase shape: each phase has its own prompt, model, and tool whitelist; conversation history carries across phase boundaries. Mutually exclusive with `user:`. |
| `phase_models` | Per-phase model overrides keyed by phase name. Lets you stick with the template's phase prompts but swap models. |
| `cron` | Five-field cron expression (`min hour day month dow`). Omitted = role never fires automatically. |
| `spaces` | Spaces the role can *read* from. `[self]` (default), a list of space names, or `["*"]` for all. Writes always target the firing space. |

### How merging works

| Section | Behavior when set in both global and repo files |
|---|---|
| `defaults` | **Field-level merge.** `defaults.provider` from global + `defaults.model` from repo combine; repo wins on shared fields. Bundled-template defaults apply per-role under that. |
| `roles.<name>` | **Per-role replacement** between user-global and repo-local. The repo's role entry wholesale replaces the global's — fields you don't repeat in the repo file are *not* inherited from the global override. (Both still inherit from the bundled template.) |

To carry a field from a global role override into the repo file, copy it. The asymmetry keeps role overrides predictable: when you write `roles.writer:` in your repo's YAML, you're declaring exactly what that role looks like for this repo.

### Config commands

```
arkeon-wiki config init               # create .arkeon/agents.yaml from template
arkeon-wiki config show               # print merged effective config
arkeon-wiki config validate           # schema-check the YAML
```

`config show` is the source of truth for "what is actually going to run" — it reflects the merged result of `~/.arkeon-wiki/agents.yaml`, `.arkeon/agents.yaml`, and the bundled role templates.

## Tools

Roles call tools to read state, search, and mutate the wiki. The registry is small on purpose — agents do less harm with fewer levers.

| Tool | Use |
|---|---|
| `read_file` | Read one file with line numbers. Required before `edit_file` on the same path. |
| `read_files` | Batched `read_file`, up to 10 paths in one call. |
| `list_entities` | Filtered listing of wikis and sources. Supports `type`, `label_contains`, `path_contains`, `inbound_min`/`max`, `outbound_min`/`max`, `updated_since`, `edited_by_role`, `has_tag`, `not_has_tag`, `tag_equals`, `tag_current`, `tag_outdated`, `sort`, `include_counts`, `limit`, `offset`. Full filter set is the Zod schema in `tools.ts`. |
| `list_redlinks` | Link targets without an entity row, ranked by demand. Carries up to 3 `linked_from` paths per target. |
| `get_entity` | Single entity with inbound + outbound link neighborhoods. |
| `get_entities` | Batched `get_entity`, up to 10 paths. |
| `search` | Ripgrep keyword search; OR up to 10 patterns in one pass. |
| `edit_file` | Two modes: `insert_at_line` (additive insert before a given line) and `str_replace` (exact-match search/replace). Path must have been `read_file`-ed in this run. |
| `create_file` | Create a new wiki under `wiki/**.html`. Validates the HTML envelope. |
| `delete_wiki` | Guarded full-file deletion. Reason required. Restricted to `wiki/**`. |
| `tag_entity` | Set or clear an agent-applied tag on any entity. Idempotent. |
| `mark_processed` | Shorthand for `tag_entity(role + ".processed_hash", entity.source_hash)`. The server reads the entity's current `source_hash` on the agent's behalf, so role pipelines can gate on `tag_outdated` / `tag_current` without the agent ever handling the hash. |

When you list `tools:` on a role, the runtime exposes exactly that subset to the model — any tool not listed is invisible, even if the model knows about it from training. Custom roles must declare their `tools:` array explicitly; bundled roles inherit theirs from the template.

## Providers

| Provider | What it covers | Required fields |
|---|---|---|
| `openai` | Anything on `api.openai.com` (GPT-5 family, GPT-4o, etc.) | `model` |
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
  editor:                       # cheap fast model for source integration
    model: gpt-5-mini
  writer:                       # stronger model for article drafting
    provider: anthropic
    model: claude-opus-4-7
    api_key_env: ANTHROPIC_API_KEY
```

Each role gets its own provider and key. Set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in `~/.arkeon-wiki/.env`; local models need no key.

## Verifying setup

```bash
arkeon-wiki up
arkeon-wiki init
arkeon-wiki config show       # confirm merged config — provider, model, instructions
arkeon-wiki logs -f           # tail the daemon log to watch agent runs
```

Agent runs emit human-readable lines as `[agent/<role>/<level>] ...` in the daemon log. For structured per-event traces, set `ARKEON_WIKI_AGENT_TRACE=1` before starting the daemon — one JSON object per line lands in `<arkeonHome>/agent-trace.jsonl`.

## Troubleshooting

**`Required env var OPENAI_API_KEY is not set`**
Your YAML resolved to `provider: openai`, but no key was found. Drop one in `~/.arkeon-wiki/.env`, your repo's `.env`, or shell-export it.

**`Provider 'openai-compatible' requires base_url`**
You set `provider: openai-compatible` (often inherited from a default) but didn't set `base_url`. Either set it or change to `openai` / `anthropic`.

**`Role 'X': no system prompt`**
You defined a custom role but left out `system:`. Bundled roles fall back to a template; custom roles must supply their own.

**`Role 'X': no tools configured`**
Same idea — custom roles must declare `tools:` explicitly.

**`agents.yaml uses the legacy 'triggers:' field`**
The runtime is now cron-paced. Replace `triggers:` with `cron: "<expression>"` (e.g. `cron: "*/15 * * * *"`). Per-space serialization is handled by the runtime, so the old `by_role` / `by_role_not` loop-safety options are gone.

**Schema errors from `config validate`**
Check the unknown field name; the schema is strict. The common candidates:
- `provider` accepts only `openai | anthropic | openai-compatible`
- `max_steps` must be a positive integer ≤ 100
- `tools` is an array of strings (tool names from the registry)
- `cron` must be a valid five-field unix-cron expression
