# CLI Instance Profiles

> **Partially shipped** — Per-repo auth profiles landed via `arkeon auth use/add/remove/profiles`. Named instances with auto-port isolation shipped via `arkeon up --name`. See `docs/dev/AUTH.md` for current auth state.

## What shipped

Per-repo actor switching is live. Inside an initialized repo (`arkeon init <space>`), users can:

- `arkeon auth add <name>` — create an actor on the graph and register it as a named profile
- `arkeon auth use <name>` — switch the active profile for the current repo
- `arkeon auth remove <name>` — remove a profile (optionally deactivate the actor)
- `arkeon auth profiles` — list profiles for the current instance

Profiles are scoped to a repo directory (`.arkeon/state.json` tracks `current_actor`). Actor keys are stored in the global credential store keyed by actor ID. Named instances (`arkeon up --name <slug>`) get deterministic port assignments, so multiple local stacks can coexist.

## What remains unimplemented

### Global `--profile` flag

A `--profile <name>` flag on every command, allowing single-command targeting without switching the active profile:

```
arkeon --profile staging entities list
arkeon --profile acme-prod seed --dry-run
```

This would be useful for scripting and one-off commands against non-default instances.

### Top-level `arkeon profile` command group

The original design proposed `arkeon profile list/use/create/delete/rename` as a top-level command group separate from auth. The current implementation folded profile management into `arkeon auth` since profiles are fundamentally about identity. Whether a top-level `profile` alias is worth adding is an open question.

### Profile renaming

No `rename` command exists. Workaround: `auth remove old && auth add new`.

### Global profile switching

Current profiles are per-repo only. There is no global "active profile" that applies outside of an initialized repo directory. The original design proposed a global `activeProfile` in the config store; this may not be needed given the per-repo model works well for the primary use cases.

### `ARKE_PROFILE` environment variable

A process-local override mirroring `ARKE_API_URL` / `ARKE_SPACE_ID`. Would complement the `--profile` flag.

## Open questions

1. **Global vs per-repo.** The per-repo model covers the developer workflow well. The consultant managing `acme.arkeon.tech` + `widget.arkeon.tech` might want global profiles — but they could also just use separate repo directories. Is global switching worth the complexity?
2. **Profile vs space.** A profile bundles "which instance + which key"; a space is an in-instance scoping concept. They are orthogonal. This distinction should be documented clearly if a top-level `profile` command is added.
3. **Conf store format.** If global profiles land, the config store would need to become keyed by profile name. The migration from flat to profiled is straightforward but one-way.
