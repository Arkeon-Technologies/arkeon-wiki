---
name: arkeon-smoke
description: "End-to-end smoke test: discover what's available, design realistic user flows, test them, report results."
disable-model-invocation: true
allowed-tools: "Bash(arkeon-wiki *, npx arkeon-wiki *, npx tsx *, curl *, mkdir *, rm -rf /tmp/arkeon-smoke*, ls *, cat *, which *), Read, Write, Glob, Grep"
---

# Arkeon Smoke Test

Comprehensive, exploratory smoke test of arkeon-wiki. Instead of a fixed checklist, this skill discovers what's available and tests realistic user workflows.

## Phase 0: Detect CLI

Determine how to invoke the CLI:

```bash
which arkeon-wiki 2>/dev/null && echo "global" || echo "checkout"
```

- If `arkeon-wiki` is on PATH, use `arkeon-wiki` for all commands.
- If not (repo checkout), use `npx tsx packages/arkeon/src/index.ts`.

Set a variable or alias for the rest of the test. The CLI binary is `arkeon-wiki`, not `arkeon`.

## Phase 1: Discovery

Before testing anything, understand what's available:

1. **Check stack health**: `arkeon-wiki status`
2. **Read the docs**: `arkeon-wiki guide` and `arkeon-wiki docs --format cli` to learn every available command
3. **Read the API**: `arkeon-wiki docs --format api` to learn every endpoint
4. **Inventory the features**: Make a list of all commands and endpoints, grouped by workflow

If the stack isn't running, start it: `arkeon-wiki up && arkeon-wiki seed`

## Phase 2: Design Flows

Design 4-6 realistic user flows that chain multiple features together. Each flow should simulate what a real user would do, not test features in isolation. Good flows combine commands that depend on each other.

Examples of good flows:
- "New user onboarding": init repo, add documents, search them, explore the graph
- "Research workflow": create wikis with links, traverse the graph, pull edits, push updates
- "Multi-actor collaboration": register actors, switch profiles, create content as different actors
- "Cleanup and reorganization": search, bulk fetch, delete, verify removal

Each flow should:
- Use a fresh temp directory under `/tmp/arkeon-smoke-*/`
- Exercise 3-5 different commands/endpoints in sequence
- Verify that output from one step feeds correctly into the next
- Test both the happy path and at least one edge case

## Phase 3: Execute

Run each flow, reporting results as you go:
- **PASS**: Step produced expected output
- **FAIL**: Step produced wrong output or error (include the error)
- **ISSUE**: Step worked but revealed UX friction, missing docs, or surprising behavior

Don't stop on failure — complete all flows and collect all issues.

## Phase 4: Report

```
Arkeon Smoke Test Report
========================
Flow 1: {name}          {PASS/FAIL}
  - Step details...
Flow 2: {name}          {PASS/FAIL}
  - Step details...
...

Issues found:
- {bugs, UX friction, doc gaps, surprising behavior}

Features not testable:
- {features that exist but couldn't be tested and why}
```

Clean up all temp directories when done.
