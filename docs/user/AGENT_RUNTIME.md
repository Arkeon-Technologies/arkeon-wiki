# Agent runtime

arkeon-wiki ships a small AI agent runtime that lets you wire LLMs into the wiki without writing code. Three built-in roles — `editor`, `proposer`, and `writer` — work in sequence per source: the editor integrates a new source into existing articles, the proposer emits a plan wiki of red links the editor didn't integrate, and the writer drains the red-link queue by creating new articles. You tune their model, focus, and instructions in YAML and add your own custom roles when you need them.

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
  model: gpt-5.4-mini

  # Operator notes appended to every role's system prompt. Use this to
  # steer subjects, tone, and scope without rewriting the workflow.
  instructions: |
    This wiki tracks researchers in climate science. Lean toward
    article topics relevant to that field. Use British English.

# Per-role overrides. The bundled `editor`, `proposer`, and `writer`
# roles ship as YAML templates in the package and are inherited
# automatically — fields you omit fall back to the template. Custom
# roles appear here too.
roles:
  writer:
    model: gpt-5.4-mini
    max_steps: 25
    cron: "*/15 * * * *"        # tighten or relax the cadence
    instructions: |
      Lead each article with its thesis in the first sentence. Cite
      every claim inline as <a href> to the source file.

  link-checker:                # custom user-defined role
    provider: anthropic        # different provider per role is fine
    model: claude-opus-4-7
    api_key_env: ANTHROPIC_API_KEY
    tools: [list_entities, read_file, edit_file]
    max_steps: 30
    cron: "0 */6 * * *"        # custom roles MUST set a cron
    system: |
      You find articles with broken or missing cross-references and
      add anchors to the wikis they should connect to. Use search and
      list_entities to discover candidates.
    user: |
      Scheduled tick — check the recently-edited articles in space
      {{space_name}}.
```

### Config commands

```
arkeon-wiki config init               # create .arkeon/agents.yaml from template
arkeon-wiki config show               # print merged effective config
arkeon-wiki config validate           # schema-check the YAML
```

`config show` is the source of truth for "what is actually going to run" — it reflects the merged result of `~/.arkeon-wiki/agents.yaml`, `.arkeon/agents.yaml`, and the bundled role templates that ship with the package.

### How merging works

| Section | Behavior when set in both global and repo |
|---|---|
| `defaults` | **Field-level merge.** `defaults.provider` from global + `defaults.model` from repo combine. Repo wins on shared fields. |
| `roles.<name>` | **Per-role replacement.** If `roles.writer` exists in both files, the repo entry replaces the global entry **wholesale** — fields you don't repeat are *not* inherited from the global. |

This asymmetry keeps role overrides predictable: when you write `roles.writer:` in your repo's YAML, you're declaring exactly what that role looks like for this repo, not partially patching whatever your `~/` happens to have.

To carry over a field from a global role override, copy it. The most common case is global YAML setting universal `defaults` and the per-repo file overriding individual roles — that works without copying anything because `defaults` *do* merge.

## Bundled role templates

Three roles, each with one job, joined by a content-hash-validated tag chain on source files. Each role runs on its own cron tick; per-space serialization is enforced by an in-process mutex (at most one role at a time per space).

| Role | Cron | Tools | Job |
|---|---|---|---|
| `editor` | `0 */1 * * *` | `read_file`, `read_files`, `list_entities`, `list_redlinks`, `edit_file`, `mark_processed` | Pick one source not yet tagged at its current content hash, survey existing articles via `list_entities` + `properties.short_description`, and for each article the source bears on either (a) insert a citation-bearing paragraph into Evidence / revise the Current Answer via `edit_file`, or (b) append a red-link `<li>` to the article's `<h2>Open threads</h2>`. Tags the source `editor.processed_hash=<source_hash>` when done. Never creates new articles. |
| `proposer` | `0 */1 * * *` | `read_file`, `read_files`, `list_entities`, `list_redlinks`, `get_entity`, `get_entities`, `create_file`, `mark_processed` | Gated on the editor's tag (`tag_current="editor.processed_hash"`). Calls `get_entity` on the source path to see which articles the editor integrated this source into, identifies the GAP — questions the source raises that no existing article (and no queued red link) covers — and writes a plan wiki at `wiki/_plans/<encoded>.html` listing those gaps as red links. Tags the source `proposer.processed_hash`. Never edits existing articles. |
| `writer` | `*/15 * * * *` | `read_file`, `read_files`, `list_entities`, `list_redlinks`, `get_entity`, `get_entities`, `search`, `create_file` | Red-link-driven. Picks the highest-demand entry from `list_redlinks`, follows its linkers back to source files, and creates the article via `create_file` at `wiki/<slug>.html`. Create-only — `edit_file` is not in its whitelist. Empty red-link queue → no-op, no fallback "invent something" branch. |

The pipeline is **sequential per source** by data dependency: editor marks → proposer eligible to run → both contribute red links → writer drains them. Content changes invalidate both source markers so the source re-enters both queues automatically.

The templates ship as YAML files in the package (`src/server/agents/templates/<name>.yaml`) and are loaded fresh from disk on every agent run. You can override any field of a template (`provider`, `model`, `tools`, `max_steps`, `cron`, `reasoning_effort`, `instructions`, `system`, `user`) in your `.arkeon/agents.yaml` without redefining the whole role. To inherit the workflow but bias the focus, set `instructions:` only.

Default model for all three: `gpt-5.4-mini`, `reasoning_effort: low`. The single-role-per-tick decomposition lets a small model handle each job reliably — the previous single-writer role needed `reasoning_effort: medium` for the integrated workload.

**First-run cost note**: a fresh `arkeon-wiki up` against a corpus with `OPENAI_API_KEY` set will start spending API credit within 15 minutes. Override the cadence in `.arkeon/agents.yaml` (`cron: "0 0 31 2 *"` is the canonical "never fire" idiom — Feb 31 doesn't exist) to inspect behavior before letting it run.

Provenance: every article authored by `writer` cites its source inline as `<a href="../sources/...">`. The existing link-resolution path turns those into edges in the `relationships` table — so "which sources contributed to this article?" is a SQL query over `relationships`, not a separate inbox.

## Custom roles

Define a custom role by adding any name under `roles:` that doesn't match a bundled template. Custom roles **must** specify:

- `system:` — the full system prompt (the workflow)
- `tools:` — list of tool names from the registry
- `cron:` — when to fire (the scheduler is purely cron-driven; no file-event triggers)

Optional: `provider`, `model`, `api_key_env`, `base_url`, `max_steps`, `reasoning_effort`, `user` (template), `instructions`.

The available tools are:

| Tool | Use |
|---|---|
| `list_entities` | Filter the corpus by `type` (`wiki` / `file`), `label_contains`, `path_contains`, inbound/outbound counts, `edited_by_role`, `updated_since`, and tag predicates (`tag_current`, `tag_outdated`, `has_tag`, `not_has_tag`, `tag_equals`). |
| `list_redlinks` | Link targets without a matching entity row, aggregated by demand. The writer's primary queue. |
| `search` | Keyword search via ripgrep. OR up to 10 patterns in one call. Returns ranked file hits with snippets. |
| `read_file` | Read one file's contents (line-numbered for use with `insert_at_line`). Registers the path in the per-run read-gate so `edit_file` is allowed on it. |
| `read_files` | Batched `read_file` (up to 10 paths in one turn). Same read-gate semantics. |
| `get_entity` | Fetch one entity with both directions of its link neighborhood (`inbound` + `outbound`). The single-call answer to "what cites this?" and "what does this connect to?". |
| `get_entities` | Batched `get_entity` (up to 10 paths). The standard primitive for surveying N linkers of a red link. |
| `edit_file` | Mutate an existing file. Two modes: `insert_at_line { line_number, content }` (additive; lines shift down) and `str_replace { old_string, new_string }` (exact-match SEARCH/REPLACE, must match once). Read-gated: refuses paths the agent hasn't `read_file`-ed in this run. |
| `create_file` | New wiki under `wiki/<slug>.html`. Requires a full HTML document (`<!DOCTYPE>` or `<html>` + non-empty `<title>` + `<body>`). Fails if the path exists. |
| `delete_wiki` | Guarded full-file deletion (only paths under `wiki/**`, required `reason` arg). Not in the bundled roles' whitelists. |
| `tag_entity` | Set or clear an agent-applied tag (`entities.tags` JSON column, distinct from `properties`). Pass `null` to delete. Free-form key/value bookkeeping for multi-agent pipelines. |
| `mark_processed` | Sugar over `tag_entity` for the canonical "I did this" idiom — writes `tags["${role}.processed_hash"] = source_hash` server-side. The agent never handles hashes, so content-change invalidation is automatic. |

### Prompt template variables

Both `system:` and `user:` are templates. Available variables:

| Variable | Resolves to |
|---|---|
| `{{role_name}}` | The role being run. |
| `{{trigger_path}}` | The path that triggered this run (cron ticks pass an empty string; reserved for future programmatic triggers). |
| `{{space_name}}` | The space the agent is running in. |
| `{{space_watch_dir}}` | The absolute filesystem path the space watches. |

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
  model: gpt-5.4-mini

roles:
  editor:                     # default editor on cheap OpenAI
    model: gpt-5.4-mini
  proposer:
    model: gpt-5.4-mini
  writer:                     # promote the writer to Claude for prose quality
    provider: anthropic
    model: claude-opus-4-7
    api_key_env: ANTHROPIC_API_KEY
  reviewer:                   # custom role on stronger Claude
    provider: anthropic
    model: claude-opus-4-7
    api_key_env: ANTHROPIC_API_KEY
    tools: [list_entities, read_file, edit_file]
    cron: "0 */6 * * *"
    system: |
      You review recently-edited articles for clarity and citation quality...
```

Each role gets its own provider and key. Set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in `~/.arkeon-wiki/.env`; local backends need no key.

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

This runs the bundled roles against a synthetic source paragraph and prints the articles that landed, token usage, and total cost.

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

## How scheduling works

The scheduler is **purely cron-driven**. Each role has its own `cron` expression and fires independently. The file watcher's job ends at the SQLite mirror — agents pick up new state at their next scheduled tick, not on every save.

1. The file watcher fires; `syncFile` updates the SQLite index (no agent activity here).
2. On the next cron tick for a role, the scheduler attempts to acquire the per-space mutex.
3. If the mutex is free, `runAgent` runs with the role's config; on completion the mutex is released. If another role is already running in that space, the tick is **skipped** (no queue, no retry).
4. The role decides its own work from current state — typically by querying for entities with `tag_outdated="<role>.processed_hash"` (covers "never processed" + "content changed since" in one query).

This means:

- **Downtime → missed ticks are dropped.** No persistence of last-fire times, no replay. Each role's queries against current state naturally surface anything that needs work.
- **Content invalidation is automatic.** `mark_processed(path, role)` stores the source's `source_hash` under `tags["<role>.processed_hash"]`; when the file changes, the hash changes, and `tag_outdated` resurfaces the entity.
- **Per-space serialization** prevents two roles from racing on the same file. If your editor and proposer crons line up at `:00`, one runs while the other defers to its next tick.
- **New behaviors don't need scheduler changes** — a reflector role that picks articles with open threads, a bridger that rotates across spaces, etc., need only a different prompt + cron.

## What's not yet wired

- **Per-role budgets / cost caps** — set `max_steps` for now; spending caps are a planned follow-up.
- **Streaming output** — `runAgent` currently waits for the full response. Streaming will come with first-class chat surfaces in Phase 3.
- **Cross-space agent runs** — schema supports it (`relationships.target_path` is unconstrained text; the `/{other-space}/...` URL form is committed), but role prompts and the scheduler are single-space today. Returns at v0.5.
