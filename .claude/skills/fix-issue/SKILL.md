---
name: fix-issue
description: Fix a GitHub issue in an isolated worktree, test, commit, and open a PR.
disable-model-invocation: true
argument-hint: [issue-number]
allowed-tools: Read, Grep, Glob, Bash(git *, gh *, npm *, npx *, psql *, curl *, pkill *, sleep *, ls *), Edit, Write, Agent, EnterPlanMode, ExitPlanMode, ExitWorktree
---

# Fix GitHub Issue in Worktree

Fix issue #$ARGUMENTS in an isolated git worktree so `main` stays clean.

## Workflow

### 1. Claim the issue (MANDATORY — do this first)

Before doing anything else, label the issue so others know it's being worked on:

```bash
# Check if someone else is already working on it
gh issue view $ARGUMENTS --json title,body,labels,state
```

If the issue already has the `in-progress` label, **stop and warn the user** — another agent or developer may be actively working on it. Only proceed if the user confirms.

```bash
# Claim it
gh issue edit $ARGUMENTS --add-label "in-progress"
```

This label MUST be added before any planning or coding begins.

### 2. Plan

Enter plan mode. Read the issue, explore the relevant code, and design your approach.
Get user sign-off before implementing.

### 3. Create a feature branch and worktree

```
git fetch origin
git worktree add .claude/worktrees/issue-$ARGUMENTS -b fix/issue-$ARGUMENTS origin/main
```

Work exclusively inside `.claude/worktrees/issue-$ARGUMENTS/` for all file edits.

### 4. Implement the fix

- Make changes inside the worktree directory
- Follow conventions in CLAUDE.md
- Keep changes minimal and focused

### 5. Migrate and test

From the worktree directory, use `/local-dev start` to bring up an isolated stack.
It will auto-detect the worktree, pick free ports, write `.devports` and `.env`, and start Postgres + API.

**You MUST start the local dev server before writing or running any tests.**

#### Write e2e tests (required for non-trivial changes)

If the fix involves a new feature, new route, behavioral change, or anything beyond a simple bug fix:

1. Look at existing tests in `packages/arkeon/test/e2e/` to find the most relevant file
2. **Extend an existing test file** if the feature relates to an existing test domain (entities, actors, spaces, etc.)
3. **Create a new `*.test.ts` file** only if no existing file covers this domain
4. Follow the established patterns: vitest, import helpers from `helpers.ts`, async API calls, descriptive test names
5. Tests should cover the happy path and at least one error/edge case

For simple bug fixes where the existing test suite already covers the affected behavior, you may skip writing new tests — but you must still run the suite.

#### Run the test suite

```bash
# Run e2e tests — .env provides E2E_BASE_URL and ADMIN_BOOTSTRAP_KEY automatically
npm run test:e2e -w packages/arkeon
```

If tests fail, fix the issue and re-run. Do not proceed to the PR step with failing tests.

#### Tear down (after tests pass and PR is opened)

```bash
# Stop the isolated stack when done
# (use /local-dev stop from the worktree, or manually:)
source .claude/worktrees/issue-$ARGUMENTS/.devports
if [ -f /tmp/arkeon-$API_PORT.pid ]; then
  kill -TERM "$(cat /tmp/arkeon-$API_PORT.pid)" 2>/dev/null || true
fi
```

### 6. Commit and push

```
cd .claude/worktrees/issue-$ARGUMENTS
git add <changed files>
git commit -m "Fix: <summary>

Fixes #$ARGUMENTS

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push -u origin fix/issue-$ARGUMENTS
```

### 7. Open a PR and transition labels

```bash
gh pr create \
  --base main \
  --head fix/issue-$ARGUMENTS \
  --title "<short title>" \
  --body "## Summary
<bullet points>

Fixes #$ARGUMENTS

## Test plan
- [ ] e2e tests pass
- [ ] Manual verification

Generated with [Claude Code](https://claude.com/claude-code)"
```

After the PR is created, transition the issue label from `in-progress` to `in-review`:

```bash
gh issue edit $ARGUMENTS --remove-label "in-progress" --add-label "in-review"
```

### 8. Exit the worktree

After opening the PR, **always exit the worktree** using the `ExitWorktree` tool so you're not stranded:

- Use `ExitWorktree` with **keep = true** (do NOT delete the worktree)
- This returns you to the repo root and keeps the worktree on disk for the merge agent or PR review follow-ups

Tell the user the PR is open and they can clean up after merge:
```
git worktree remove .claude/worktrees/issue-$ARGUMENTS
git branch -d fix/issue-$ARGUMENTS
```

## Rules

- NEVER commit directly to main
- All work happens inside the worktree
- Run migrations if any SQL files changed
- Run e2e tests before opening the PR
- If tests fail, fix and re-test — don't open a broken PR
- **Labeling is mandatory**: `in-progress` must be added before any work begins; transition to `in-review` when the PR is opened
- If you abandon the issue (user says stop, or it's blocked), remove the `in-progress` label: `gh issue edit $ARGUMENTS --remove-label "in-progress"`
- If the issue already has `in-progress` when you start, warn the user before proceeding
- For non-trivial changes, you MUST write or extend e2e tests — do not skip this
- CRITICAL: Only ever clean up YOUR OWN worktree (`.claude/worktrees/issue-$ARGUMENTS`). NEVER run `rm -rf .claude/worktrees/`, `git worktree prune`, or remove any other worktree. Other worktrees may contain active work from other sessions. If cleanup is needed, only target the exact worktree path for this issue.
