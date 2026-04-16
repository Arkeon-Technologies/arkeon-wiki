# Context Management

How the platform communicates its capabilities to users, LLMs, and coding agents. This is the user experience layer — the thing that determines whether someone (or something) can actually use the API effectively.

## The Problem

An API with many operations across a dozen resource groups is useless if the caller doesn't know what's available. Human users can browse docs. LLM clients can't — they need the right context injected upfront, or they'll waste iterations guessing and failing.

Three audiences need to understand the same API, but through different lenses:

| Audience | Interface | Needs |
|----------|-----------|-------|
| Human via HTTP | API endpoints, curl, SDKs | Route index, parameter docs, guides |
| Human via CLI | `arkeon` commands | Command help, getting-started guide |
| Claude Code agent | Skills + CLI + HTTP | Skill instructions, `arkeon docs`, `arkeon guide` |

## Architecture

### Shared Operations (`packages/arkeon/src/shared/`)

Single source of truth for two concerns:

**Concepts** (`concepts.ts`): Named string constants defining what things are — `WHAT_IS_ARKEON`, `CORE_CONCEPTS`, `CLASSIFICATION_LEVELS`, `BEST_PRACTICES`, `FILTERING_HINT`. No tool-specific examples. Change a concept once and it propagates everywhere.

**CLI operations** (`cli-operations.ts`): The `OVERRIDES` map and `parseOperations()` function that parse an OpenAPI spec into structured `GeneratedOperation` objects. This is the single source of truth for how operationIds map to `arkeon <group> <action>` CLI commands, and how parameters, body fields, response schemas, and permission rules are extracted. Used by:
- CLI codegen script (generates Commander commands)
- `/llms.txt` (generates full API reference)

### API Help System (`packages/arkeon/src/server/`)

Layered discovery for HTTP consumers. All generated at runtime from route definitions + Zod schemas via `@hono/zod-openapi`.

**Endpoints:**

| Endpoint | Content | Source |
|----------|---------|--------|
| `GET /` | Entry point with links to all docs | Static |
| `GET /help` | Route summary index with filter syntax | `renderIndexFromSpec()` |
| `GET /help/guide` | Getting-started guide | Shared concepts + HTTP examples |
| `GET /help/guide/admin` | Admin operations guide | Static |
| `GET /help/:method/:path` | Detailed docs for one route | `renderRouteHelpFromSpec()` |
| `GET /llms.txt` | **Full API reference** — every route with all params, response shapes, rules | `renderFullApiReferenceFromSpec()` |
| `GET /openapi.json` | Full OpenAPI 3.1.0 spec | `@hono/zod-openapi` |

**`/llms.txt` is the primary LLM entry point.** It contains:
- SDK cheat sheets (TypeScript and Python) with import syntax, method signatures, configuration, error handling
- API response patterns (how responses wrap objects in named keys)
- Filter syntax reference with all operators and examples
- Complete API reference — every route with method, path, auth, parameters, request body, response schema, and permission rules

An LLM that reads `/llms.txt` once has everything it needs to use the API correctly via SDK or direct HTTP — no additional discovery calls needed.

**Custom OpenAPI extensions** communicate intent to consumers:
- `x-arke-auth` — "required" or "optional" (shown in route index)
- `x-arke-rules` — permission/authorization rule descriptions
- `x-arke-related` — cross-references to related routes

### CLI Help System (`packages/arkeon/src/cli/`)

Layered discovery for terminal users. Commands are auto-generated from the same OpenAPI spec using the shared `parseOperations()`.

**Help levels:**

```
arkeon --help                         # all command groups
arkeon <group> --help                 # commands in a group
arkeon <group> <command> --help       # full usage, params, auth, route
arkeon guide                          # getting-started guide with CLI examples
```

**Auto-generated commands** (~78 operations, 12 groups) are created by `scripts/generate-commands.ts`, which imports `parseOperations` from `src/shared/cli-operations.ts` and produces `src/generated/index.ts`.

**`arkeon docs` — offline complete reference:**

```
arkeon docs                # all formats combined (CLI + API + SDK)
arkeon docs --format cli   # CLI commands only (walks Commander tree)
arkeon docs --format api   # API reference (same content as /llms.txt, offline)
arkeon docs --format sdk   # SDK quick-reference
```

Built from the checked-in `spec/openapi.snapshot.json`, so it works without a running server. This is how Claude Code agents (and any offline tooling) get the full API reference without starting the stack.

The visual graph explorer is a separate surface at `GET /explore` (see Explorer section below) — it's not part of `arkeon docs` since it's a browser SPA, not text output.

### Skills (`packages/arkeon/assets/skills/`)

Claude Code skills are the primary AX surface for agents working *on* a knowledge graph from inside a coding assistant.

**Source files:**
- `assets/skills/meta.yaml` — skill definitions with provider frontmatter (allowed tools, model settings)
- `assets/skills/body/*.md` — skill body content
- `assets/skills/agents.md` — agent-facing quick reference bundled in Genesis seed

**Build pipeline:** `scripts/bundle-assets.ts` composes meta.yaml + body + provider frontmatter into complete skill files. Output lands in `src/generated/assets.ts`.

**Distribution:** `arkeon claude install` writes composed skills to `~/.claude/skills/`. An `arkeon:managed` comment lets the installer detect and update stale skills on version change.

### Explorer (`packages/explorer/`)

Browser SPA for visual graph exploration, served at `GET /explore`. Built with Vite, bundled into `dist/explorer/` as part of the `arkeon` build, ships inside the npm tarball. Not a separate package — just a build artifact.

## Data Flow

```
Route definitions (createRoute + Zod)
        |
        v
  OpenAPI spec (runtime)
        |
        +---> /openapi.json
        +---> /help (renderIndexFromSpec — summary)
        +---> /llms.txt (renderFullApiReferenceFromSpec — complete)
        +---> /help/:method/:path (renderRouteHelpFromSpec — per-route)
        +---> CLI commands (parseOperations at build time)
        +---> arkeon docs --format api (offline, from snapshot)

Shared concepts (packages/arkeon/src/shared/concepts.ts)
        |
        +---> API guide (/help/guide) + HTTP examples
        +---> CLI guide (arkeon guide) + CLI examples

Shared operations (packages/arkeon/src/shared/cli-operations.ts)
        |
        +---> CLI codegen (generate-commands.ts)
        +---> /llms.txt (renderFullApiReferenceFromSpec)

Skill sources (assets/skills/meta.yaml + body/*.md)
        |
        +---> bundle-assets.ts
        +---> src/generated/assets.ts
        +---> arkeon claude install → ~/.claude/skills/

Explorer SPA (packages/explorer/)
        |
        +---> Vite build
        +---> dist/explorer/ → GET /explore
```

## Maintaining This System

**Adding a route:** Define it with `createRoute()` and Zod schemas. It automatically appears in `/help`, `/llms.txt`, `/openapi.json`, and CLI commands (after `npm run build -w packages/arkeon`). If the route needs a non-default CLI group/action mapping, add an entry to `CLI_OVERRIDES` in `packages/arkeon/src/shared/cli-operations.ts`.

**Changing a concept:** Edit `packages/arkeon/src/shared/concepts.ts`. The API guide and CLI guide update automatically.

**Changing SDK examples:** Edit the `FILTER_SYNTAX_BLOCK` preamble in `packages/arkeon/src/server/lib/openapi-help.ts` (`/llms.txt`).

**Changing a skill:** Edit `assets/skills/meta.yaml` (metadata/frontmatter) or `assets/skills/body/*.md` (content). Rebuild (`npm run build -w packages/arkeon`) to regenerate `src/generated/assets.ts`. Users pick up changes on next `arkeon claude install` or automatically on version change.

**Adding a new skill:** Add the skill definition to `meta.yaml` and its body to `body/<name>.md`. The build pipeline handles composition and distribution.

**Updating `arkeon docs` output:** Happens automatically when the OpenAPI snapshot is regenerated. No separate step.

## Complete Surface Map

Quick reference for where each audience gets context:

| Surface | Audience | Auto-generated? | Source of truth |
|---------|----------|-----------------|-----------------|
| `GET /llms.txt` | External LLMs, SDK users | Yes (runtime) | Route definitions + Zod schemas |
| `GET /help` | HTTP users | Yes (runtime) | Route definitions |
| `GET /help/guide` | HTTP users | Partial (concepts auto, examples manual) | `concepts.ts` + `help.ts` |
| `GET /openapi.json` | Tool builders | Yes (runtime) | Route definitions |
| `arkeon docs` | CLI users, offline agents | Yes (build-time) | OpenAPI snapshot |
| `arkeon guide` | CLI users | Partial | `concepts.ts` + `guide/index.ts` |
| `arkeon <cmd> --help` | CLI users | Yes (build-time) | OpenAPI snapshot |
| Skills | Claude Code agents | Yes (build-time) | `assets/skills/meta.yaml` + `body/*.md` |
| Explorer | Browser users | Yes (build-time) | `packages/explorer/` |

## Why This Matters

An agent can succeed in a handful of iterations or burn through fifteen
on the same task, and the difference is almost entirely about starting
context. A well-informed agent:

1. Knows every operation and its exact syntax (full CLI reference / `/llms.txt`)
2. Knows what comes back (response patterns — `entity.id`, not `.id`)
3. Knows how to avoid mistakes (idempotency guidance, `--raw` for piping)
4. Understands the domain model (shared concepts)
