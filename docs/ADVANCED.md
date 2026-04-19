# Advanced and in-development features

Features that are functional but under active development. They may
change significantly between releases. If you're evaluating Arkeon,
start with the [quickstart](user/QUICKSTART.md) — everything below is
opt-in and not required for core usage.

---

## Worker configuration (`workers.yaml`)

Workers are background processes that enrich your knowledge graph. Currently
implemented: the **extractor** resolves placeholder links into entities, and
the **drafter** writes wiki content for stub entities. Additional workers
(consolidator, connector) are planned but not yet available.

Configure them via `~/.arkeon-wiki/workers.yaml` (override path with
`ARKEON_WORKERS_CONFIG`). If the file doesn't exist, built-in defaults
apply.

### Global LLM settings

The top-level `llm:` block sets the default LLM for all workers:

```yaml
llm:
  provider: openai          # openai | anthropic | openrouter
  base_url: https://api.openai.com/v1
  api_key: sk-...
  model: gpt-4o
  max_tokens: 4096
```

This supersedes `llm.json` (which still works as a lower-priority fallback).

### Per-worker settings

Each worker can be individually configured under `workers:`:

```yaml
workers:
  extractor:
    enabled: true
    prompt_mode: append       # prepend | append | replace
    prompt: "Extra domain rules for extraction..."
    llm:
      model: gpt-4o-mini     # override model for this worker
    steps:
      resolve: { model: gpt-4o-mini, max_tokens: 256 }
      exists:  { model: gpt-4o-mini, max_tokens: 512 }

  drafter:
    enabled: true
    poll_interval: 10s        # how often to check for work
    batch_size: 5             # entities per batch
    max_depth: 2              # link-follow depth
    llm:
      model: gpt-4o
      max_tokens: 8000

  # consolidator and connector are planned but not yet implemented
```

### Prompt customization modes

- **`append`** (default) — your custom prompt is added after the built-in prompt
- **`prepend`** — your custom prompt is added before the built-in prompt
- **`replace`** — your custom prompt completely replaces the built-in prompt

### LLM resolution priority

When a worker makes an LLM call, the model/config resolves in order:

1. Per-step config (e.g., `workers.extractor.steps.resolve`)
2. Per-worker `llm` block (e.g., `workers.extractor.llm`)
3. Top-level `llm` block
4. `llm.json` fallback (legacy)

---

## Rate limiting (not implemented)

Arkeon currently ships **without any in-process rate limiting**. This is
deliberate for the current phase — the product target is a local-first
tool that users run on their own machine via `arkeon up`, and a local
limiter mostly just gets in the way of legitimate browser traffic and
scripts.

For public or multi-tenant deployments this will need to be revisited.
When we do, the design notes below capture the decisions we already
wrestled with so we don't re-litigate them.

### Why "just add a token bucket" is not the answer

An earlier iteration of this repo shipped an in-process per-IP token
bucket keyed on the remote address. It had three problems that together
argued for ripping it out and doing this properly later:

1. **Path exemption was a bypass vector.** A single explorer SPA load
   fetches 20–40 static assets in parallel, easily exceeding any
   reasonable burst cap. We worked around that by exempting `/explore/*`
   and `/help/*` by path — at which point an attacker could just hit
   those paths in a loop to drain CPU and the limiter provided no
   protection. Once you start exempting by path you've admitted the
   limiter can't distinguish abuse from legitimate load.

2. **"Has an API key header" is not the same as "is authorized".** The
   first version bypassed any request that *presented* an API key
   header, which meant an attacker could skip the bucket entirely with
   `-H 'x-api-key: anything'` and then brute-force the `api_keys`
   SELECT at full speed. We tried to fix this with a validated-key
   cache (see the commit history for `valid-keys-cache.ts`) but the
   cache introduces its own eviction, cold-start, and multi-replica
   concerns, and it still leaves the SELECT reachable for the first
   N requests per IP before throttling kicks in.

3. **Wrong layer.** In-process rate limiting in a Node server behind a
   load balancer is strictly worse than edge rate limiting at the LB
   itself. Cloudflare, AWS WAF, nginx `limit_req`, and the control
   plane's Cloudflare Worker can all do this with per-route rules,
   global counters, and proper observability. A home-grown token
   bucket inside the API process ends up duplicating state across
   replicas and is invisible to the ops dashboards.

### What to do instead, when the time comes

- **For the managed SaaS control plane (`arkeon-deploy`)**: apply rate
  limits at the Cloudflare layer in front of `deploy.arkeon.tech`.
  This is the correct spot — it sees every request, has per-tenant
  context from the deployment slug, and costs zero extra infra.

- **For user-owned per-tenant instances behind `{slug}.arkeon.tech`**:
  apply rate limits in the per-instance nginx/Caddy that fronts the
  API container, or enable Cloudflare's HTTP rate-limiting rules for
  the instance's hostname. Configure by plan tier.

- **For the bare API process** (users running `arkeon up` directly):
  no limiter by default. If a user wants one for some reason, the
  right shape is probably per-actor quotas recorded in the database
  (rows in `api_keys` with last-N-minute counters), not per-IP
  buckets. Per-actor is a straightforward migration once we have real
  abuse signal to design against.

### What to bring back if we do this

If we do implement something in-process (e.g. for a proof-of-concept
deployment before Cloudflare is wired up), the thing to reach for is
the **validated-key cache** pattern — not the token bucket itself.
Track which key hashes have already validated against `api_keys` and
skip the SELECT on subsequent requests. That's a win regardless of
whether there's a rate limit on top of it, because it removes load
from the most heavily hit query in the auth path.
