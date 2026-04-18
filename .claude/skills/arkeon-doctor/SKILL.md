---
name: arkeon-doctor
description: Build, test, version-bump, and publish the arkeon npm package from main.
disable-model-invocation: true
argument-hint: [patch|minor|major]
allowed-tools: Bash(npm *, npx *, git *, gh *, node *, cat *, ls *, curl *), Read, Glob, Grep
---

# Arkeon Doctor

Build, verify, and publish the `arkeon` npm package. Handles the full release flow: typecheck, build, smoke test, version bump, and GitHub Release (which triggers the publish workflow).

## 1. Pre-flight checks

Verify you're on the `main` branch and it's clean:

```bash
git status --porcelain
git branch --show-current
```

If not on main or working tree is dirty, stop and tell the user.

Pull latest:

```bash
git pull
```

## 2. Check what's unreleased

Compare the current npm version against HEAD:

```bash
npm view arkeon version
git log $(git describe --tags --match 'arkeon-v*' --abbrev=0 2>/dev/null || echo HEAD~20)..HEAD --oneline
```

Report the published version and the commits that will be included. If there are no new commits since the last tag, tell the user there's nothing to release and stop.

## 3. Build

Build in the correct order:

```bash
npm run build -w packages/arkeon
```

This must succeed. If it fails, report the error and stop.

## 4. Typecheck

```bash
npm run typecheck -w packages/arkeon
```

Must pass cleanly. If it fails, report the errors and stop.

## 5. Unit tests

```bash
npm test -w packages/arkeon
```

Must pass. Report failures and stop if any.

## 6. Verify build health

Check the dist output matches expected structure:

```bash
ls -la packages/arkeon/dist/
du -sh packages/arkeon/dist/
```

Verify:
- `dist/index.js` exists (~200KB)
- `dist/server-*.js` exists (~500KB)
- `dist/explorer/` exists
- `dist/schema/` exists with .sql files
- Total size is under 4MB

If any check fails, report and stop.

## 7. Determine version

The `$ARGUMENTS` parameter controls the bump type:
- `patch` (default if no argument): `0.3.2` -> `0.3.3`
- `minor`: `0.3.2` -> `0.4.0`
- `major`: `0.3.2` -> `1.0.0`

Read the current version from `packages/arkeon/package.json` and compute the next version. Report:

> **Ready to publish `arkeon@{next_version}`**
> - {N} commits since {last_tag}
> - Build: OK ({size} dist)
> - Typecheck: OK
> - Tests: OK

Ask the user to confirm before proceeding.

## 8. Create GitHub Release

Create the release which triggers the publish workflow:

```bash
gh release create arkeon-v{next_version} --generate-notes --target main
```

## 9. Monitor publish

Check that the GitHub Actions workflow started:

```bash
gh run list --workflow=publish.yml --limit 1
```

Report the run URL so the user can monitor it. Then poll until it completes:

```bash
gh run watch {run_id}
```

## 10. Verify published version

After the workflow succeeds, confirm the new version is live on npm:

```bash
npm view arkeon version
```

Report:

> **Published `arkeon@{next_version}` to npm.**
> Users can update with: `arkeon update` (stops running instances, installs, restarts)
