# Arkeon Wiki Ingest

Add files to the knowledge graph, monitor extraction and drafting, then help the user review and refine results. This skill is idempotent -- safe to run repeatedly on the same repo.

## Prerequisites

Before starting, verify the stack is running:

```bash
arkeon-wiki status
```

If the stack is not running, start it: `arkeon-wiki up`

Next, verify LLM is configured (required for extraction and drafting):

```bash
arkeon-wiki config get-llm
```

If `configured: false`, the workers won't process any documents. Set a key before continuing:

```bash
arkeon-wiki config set-llm-key <your-api-key>
arkeon-wiki down && arkeon-wiki up
```

Without an LLM key, files can be added but step 3 (monitoring extraction/drafting) will show no progress -- the workers are disabled.

If the stack needs broader diagnosis, run `/arkeon-wiki-doctor`.

Check that the current directory is initialized:

```bash
cat .arkeon/state.json 2>/dev/null || echo "NOT INITIALIZED"
```

If not initialized, run:

```bash
arkeon-wiki init
```

## 1. Scan for changes

Check what files are new or modified compared to the graph:

```bash
arkeon-wiki diff
```

This shows files categorized as added, modified, deleted, or unchanged. Report the summary to the user.

If `$ARGUMENTS` specifies file paths or directories, use those instead of the full diff.

If there are no changes, let the user know:

> All files are up to date with the knowledge graph. Nothing to add.
> 
> Options:
> - Add new files to this directory and run again
> - Run `arkeon-wiki pull` to download wikis for local editing
> - Open the explorer at {api_url}/explore

## 2. Add files

Add the files that need processing:

```bash
arkeon-wiki add $ARGUMENTS
```

Or if no arguments were provided, add all new/modified files shown by diff:

```bash
arkeon-wiki add <paths from diff>
```

Report what was added/updated/skipped from the JSON output.

## 3. Monitor extraction and drafting

The extraction and drafting workers process files asynchronously. Poll the queue status to track progress.

Read the admin key:

```bash
cat ${ARKEON_WIKI_HOME:-~/.arkeon-wiki}/secrets.json
```

Then poll the queues endpoint (use the `api_url` from `.arkeon/state.json`):

```bash
curl -s -H "Authorization: ApiKey {admin_key}" "{api_url}/queues?recent=10"
```

Report progress to the user as it happens:

> **Extraction:** {complete}/{total} files processed
> **Drafting:** {complete} wikis drafted, {pending} pending, {undraftable} skipped
> **Currently drafting:** {label}

Keep polling every 10-15 seconds until both queues have no pending or processing items. Report each significant change (new completions, errors).

If any items are marked `undraftable`, note them but don't treat it as an error -- the draft worker may not have had enough context. These can be revisited later.

## 4. Report results

Once all queues are drained, summarize what was generated and prompt the user to open the explorer:

> **Ingest complete.**
> - Files processed: {N}
> - Entities extracted: {count from extraction}
> - Wikis drafted: {complete count}
> - Undraftable: {count} (if any)
>
> **Open the explorer to see your knowledge graph:**
> {api_url}/explore

Always display the full clickable explorer URL. Read the `api_url` from `.arkeon/state.json` (typically `http://localhost:8000`).

## 5. Offer next steps

Ask the user what they'd like to do:

> **What next?**
> 1. **Add more files** -- point me at more files or directories
> 2. **Pull wikis** -- download drafted wikis as editable markdown (`arkeon-wiki pull`)
> 3. **View in explorer** -- open {api_url}/explore in your browser
> 4. **Done** -- everything looks good

### If user wants to pull and edit:

```bash
arkeon-wiki pull
```

This writes wikis to `wiki/{subject_type}/{slug}.md` with YAML frontmatter. The user can edit these files, then re-add them:

```bash
arkeon-wiki add wiki/
```

Pulled wikis go through `PUT /wiki/{id}` (wiki pipeline) which re-resolves links and updates relationships. This is safe to do repeatedly.

### If user wants to add more files:

Go back to step 1 (scan + add). The extraction is idempotent -- re-extracting a file only creates new entities that weren't previously extracted.

### If user re-adds a modified raw document:

The file's `source_hash` is compared. If changed, the file is updated and re-enqueued for extraction. The extract worker checks what was already extracted and only creates placeholders for genuinely new subjects. Previously extracted entities are preserved.
