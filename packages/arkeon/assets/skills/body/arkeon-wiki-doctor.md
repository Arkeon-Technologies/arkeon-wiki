# Arkeon Wiki Doctor

Set up, configure, and diagnose a local arkeon-wiki installation. Handles first-time setup and ongoing health checks.

Run each section in order. Report results as you go. If a section fails, fix it before continuing.

## 1. Installation check

```bash
npx arkeon-wiki --version 2>/dev/null || echo "NOT INSTALLED"
```

If not installed, tell the user:

> arkeon-wiki is not installed. Install it with: `npm install -g arkeon-wiki`

Then stop. The remaining steps require the CLI.

## 2. Stack status

```bash
arkeon-wiki status
```

Interpret the JSON output:
- `state: "running"` + `health: true` + `ready: true` -- stack is healthy, continue to step 3
- `state: "running_unhealthy"` -- process alive but API not responding. Suggest `arkeon-wiki logs`
- `state: "not_running"` -- stack is down, start it:

```bash
arkeon-wiki up
```

Wait for the output to confirm the API is ready. The `up` command prints the admin key and API URL.

## 3. LLM configuration

The extraction and drafting workers need an LLM API key to function. Check if one is configured:

```bash
arkeon-wiki config get-llm
```

Interpret the JSON output:
- `configured: true` -- LLM is ready. Note the `source` (workers.yaml, llm.json, or OPENAI_API_KEY) and `model`. Continue to step 4.
- `configured: false` -- no API key found. Guide the user:

> No LLM API key found. The extraction and drafting workers need one to generate wiki content.
>
> **Quickest setup:**
> ```bash
> arkeon-wiki config set-llm-key <your-api-key>
> ```
>
> This writes to `~/.arkeon-wiki/llm.json`. Works with any OpenAI-compatible API (OpenAI, Anthropic via proxy, local models via Ollama/LM Studio).
>
> **For a custom provider or model:**
> ```bash
> arkeon-wiki config set-llm-key <key> --model gpt-4o --base-url https://api.openai.com/v1
> ```
>
> **Model recommendations:**
> - Best quality: `gpt-4o` or `claude-sonnet-4-20250514`
> - Budget-friendly: `gpt-4o-mini` (good for extraction, lighter for drafting)
>
> **Advanced:** For per-worker/per-step model assignment (e.g. a cheaper model for extraction, a stronger one for drafting), create `~/.arkeon-wiki/workers.yaml`. See `arkeon-wiki docs --format api` for the full config schema.
>
> After setting the key, restart the stack: `arkeon-wiki down && arkeon-wiki up`

## 4. Repo binding

Check if the current directory is initialized as an arkeon-wiki space:

```bash
cat .arkeon/state.json 2>/dev/null || echo "NOT INITIALIZED"
```

If initialized, report the space name, API URL, and actors. If not:

> This directory is not bound to an arkeon-wiki space. To initialize:
> ```bash
> arkeon-wiki init [space-name]
> ```
> This creates a space and binds this directory to it. The space name defaults to the directory name.

## 5. State directory

```bash
ls -la ${ARKEON_WIKI_HOME:-~/.arkeon-wiki}/ 2>/dev/null || echo "STATE DIR MISSING"
```

Verify:
- `secrets.json` exists (admin key and encryption key)
- `data/postgres/` exists (embedded Postgres data)
- `bin/meilisearch` exists (search engine binary)

If the state directory doesn't exist, `arkeon-wiki up` will create it on first run.

## 6. API health (if stack is running)

Use the `api_url` from `arkeon-wiki status` output:

```bash
curl -sf {api_url}/health
curl -sf {api_url}/ready
```

Report whether each responds with `status: "ok"`.

## 7. Report

Summarize all findings:

```
Arkeon Wiki Doctor
==================
Installed:  {version} (latest: {npm_version}) {OK or UPDATE AVAILABLE}
Stack:      {running/started/not running}
LLM:        {configured (model) / NOT CONFIGURED}
Health:     {ok/unhealthy/n/a}
Database:   {ready/unreachable/n/a}
State dir:  {path} {OK/MISSING}
Repo:       {bound to space "X" / not initialized}
```

If everything is healthy, suggest next steps:
- If repo not initialized: `arkeon-wiki init`
- If initialized and ready: `Run /arkeon-wiki-ingest to add files and generate wikis`
- If LLM not configured: `arkeon-wiki config set-llm-key <key>`, then `arkeon-wiki down && arkeon-wiki up`
