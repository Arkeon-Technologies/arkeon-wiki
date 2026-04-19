# Arkeon Doctor

Diagnose the health of the user's local Arkeon installation. Check that all components are running, up to date, and correctly configured.

Run each section in order. Report results as you go using clear pass/fail indicators.

## 1. Version check

Check the installed version and whether an update is available:

```bash
arkeon --version
npm view arkeon version
```

Compare the two. If the installed version is older, note it but continue — do not auto-update.

## 2. Stack liveness

```bash
arkeon status
```

Interpret the JSON output:
- `state: "running"` + `health: true` + `ready: true` — stack is healthy
- `state: "running"` + `health: true` + `ready: false` — API is up but database is unreachable
- `state: "running_unhealthy"` — process alive but API not responding. Suggest `arkeon logs`
- `state: "not_running"` — stack is down. Note it and continue checks

If the stack is not running, skip sections 3–5 (they require a live API).

## 3. API health

Use the `api_url` from the `arkeon status` output (e.g. `http://localhost:8000`) to probe endpoints directly:

```bash
curl -sf {api_url}/health
curl -sf {api_url}/ready
```

Report whether each responds with `status: "ok"` / `status: "ready"`.

## 4. Seed state

From the `arkeon status` output, check:
- `seed_loaded` — whether the Genesis demonstration wikis are loaded
- If not loaded, suggest: `arkeon seed`

## 5. State directory

Check the state directory exists and has the expected structure:

```bash
ls -la ~/.arkeon-wiki/
```

Verify:
- `secrets.json` exists (admin key)
- `data/postgres/` exists (embedded Postgres data)
- `bin/` exists (Meilisearch binary)

If `ARKEON_WIKI_HOME` is set, check that directory instead.

## 6. Repo binding (if applicable)

Check whether the current working directory is bound to an Arkeon instance:

```bash
cat .arkeon/state.json 2>/dev/null
```

If the file exists, report the bound space name, API URL, and actors. If not, note that this directory is not initialized as an Arkeon knowledge base (not an error — just informational).

## 7. Report

Summarize all findings in a single diagnostic report:

```
Arkeon Doctor Report
====================
Version:    {installed} (latest: {latest}) {OK or UPDATE AVAILABLE}
Stack:      {running/not running}
Health:     {ok/unhealthy/n/a}
Database:   {ready/unreachable/n/a}
Seed:       {loaded/not loaded/n/a}
State dir:  {path} {OK/MISSING}
Repo:       {bound to space "X"/not initialized}
```

If any issues were found, list recommended actions at the bottom. If everything is healthy, say so.
