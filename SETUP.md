# Setting up an arkeon-wiki

A walkthrough for going from zero to a corpus the agents are actively writing into. Works equally well if you're running the commands by hand or asking Claude Code (or any coding agent) to drive — every step is a concrete command.

The README explains *what* arkeon-wiki is. This doc gets you to a wiki that's producing real articles. Budget: 15-20 minutes plus a few cents in LLM credit.

## 1. Prerequisites

- Node 18 or newer
- An API key from one of: OpenAI (default), Anthropic, or any OpenAI-compatible backend (Ollama, OpenRouter, Groq, LM Studio, vLLM, …)

If you don't have a global install yet:

```bash
npm install -g arkeon-wiki
```

## 2. Drop your API key in `.env`

Write the key **before** you start the daemon. The daemon snapshots `process.env` at launch — adding `.env` after `arkeon-wiki up` requires a restart for the key to land.

```bash
mkdir -p ~/.arkeon-wiki
echo "OPENAI_API_KEY=sk-..." > ~/.arkeon-wiki/.env
chmod 600 ~/.arkeon-wiki/.env
```

(Substitute `ANTHROPIC_API_KEY` if that's what you're using. For OpenAI-compatible backends, also set the `base_url` in your per-repo `.arkeon/agents.yaml` later.)

Shell `export OPENAI_API_KEY=...` works too and takes precedence over the file.

## 3. Start the daemon

```bash
arkeon-wiki up
```

This forks a detached background process that runs SQLite + the API server on `http://localhost:8000`. It survives terminal close. Stop it with `arkeon-wiki down`. State (database, pidfile, log) lives in `~/.arkeon-wiki/`.

Verify:

```bash
arkeon-wiki status
curl http://localhost:8000/health
```

## 4. Initialize your directory

`cd` to wherever your corpus will live, then:

```bash
arkeon-wiki init
```

One command, four effects:

1. Registers the directory as a **space** with the daemon. The file watcher starts immediately.
2. Writes `.arkeon/state.json` (per-clone, gitignored).
3. Creates `wiki/` (where the agents will author).
4. Lays down `.arkeon/agents.yaml` from the bundled `wiki` template, and adds both `.arkeon/state.json` and `.env` to `.gitignore` (creating `.gitignore` if missing).

The output payload reports what was created or already in place. If you re-run `init` after editing the YAML by hand, it reconciles missing pieces (e.g. restores `agents.yaml` if you deleted it) without ever clobbering hand-edits.

## 5. Opinionate the wiki

This is the most consequential step. Without an `instructions:` block your agents will write a generic encyclopedia on whatever's in front of them; with it, the corpus develops a point of view.

Open `.arkeon/agents.yaml`. Find the commented-out `instructions:` block in `defaults:`. Uncomment it and replace the placeholder text. The block is appended to every role's system prompt without disturbing the workflow.

A strong `instructions:` answers four questions:

- **What is the wiki about, and what is it *not* about?**
- **What kinds of articles should be written?** (Surveys? Questions and answers? Polemics? Concept-by-concept reference?)
- **What voice?** (Encyclopedia neutrality, primary-source-voice, opinionated, contrarian, etc.)
- **Who's the audience?** (Practitioners, newcomers, you-six-months-from-now, etc.)

Concrete example — a wiki built on Augustine and G. K. Chesterton, asking how their critique of pure reason applies to the modern world:

```yaml
defaults:
  provider: openai
  model: gpt-5-mini
  instructions: |
    This wiki develops a Christian critique of modern intellectual
    prides — rationalism, scientism, and the unexamined faith in
    pure reason. The corpus is Augustine and G. K. Chesterton,
    primary texts only (Confessions, City of God, Orthodoxy,
    Heretics).

    The driving question: how would these authors apply their
    Christian ideals to the modern world, and which of the modern
    certainties they attacked still go unchallenged today?

    What to write:
    - Questions that surface when ancient/Christian thought meets
      modern certainties.
    - Articles that take a clear side. These authors had positions
      — the wiki should not water them down into balanced
      "perspectives" prose.
    - Specific citations. Augustine by book + chapter
      (Confessions VII.5; City of God I.1). Chesterton by chapter
      title (Orthodoxy ch. III "The Suicide of Thought").

    Tone:
    - Direct, opinionated, occasionally polemical. Match the voice
      of the sources. Chesterton paradoxes are fine; Augustine's
      confessional personalism is fine. Don't flatten either into
      encyclopedia voice.

    Out of scope:
    - "How modern Christians have responded to X." Secondary
      commentary doesn't belong here.
    - Apologetics primers for newcomers.
    - Hedging. Sentences that begin "Some have argued..." defeat
      the project.

    Audience:
    - Readers familiar with these authors or willing to chase a
      citation.
```

Verify the parse + the merged config:

```bash
arkeon-wiki config validate
arkeon-wiki config show
```

The `instructions:` text will appear under `defaults:` in the `config show` output.

## 6. Add your sources

Drop text files anywhere in the directory (any subfolder is fine — `sources/`, `notes/`, top-level, doesn't matter). The watcher picks them up automatically.

**Supported extensions**: `.txt`, `.html` (outside `wiki/`), `.json`, `.csv`, `.xml`, `.rst`. Anything else is **silently ignored** — Markdown, PDFs, DOCX, images, binaries.

Check what the watcher actually sees:

```bash
arkeon-wiki sources scan
```

The output partitions every file into supported / unsupported. Unsupported entries list up to 5 example paths per extension. Convert anything you wanted indexed:

| Source | Recommended converter |
|--------|----------------------|
| PDF | `pdftotext file.pdf file.txt` (poppler-utils) |
| DOCX | `pandoc file.docx -o file.txt` |
| Markdown | `cp file.md file.txt`, or convert with `pandoc -o file.html` if you want HTML semantics |
| HTML web pages | already supported as `.txt` if you save the page text; or use `pandoc` to clean |
| EPUB | `pandoc file.epub -o file.txt` |

A re-run of `sources scan` after conversion confirms zero unsupported files.

## 7. First-cycle smoke test

Three roles cooperate, in order:

- **`editor`** reads one source per tick and adds citations / open-thread red links to *existing* articles. On a fresh corpus with no articles yet, it tags-and-skips. **0 edits is the expected first-tick outcome — don't panic.**
- **`proposer`** picks up the source the editor just tagged, identifies questions no article covers yet, and emits them as red links in a per-source plan wiki at `wiki/_plans/<source-path>.html`.
- **`writer`** drains the highest-demand red link, one article per tick. This is where the corpus starts to fill in.

Drive one manual cycle to verify your `instructions:` produces what you want before letting cron loose:

```bash
arkeon-wiki agent run editor       # tags the first source. 0 edits expected.
arkeon-wiki agent run proposer     # creates wiki/_plans/<source>.html with red links
arkeon-wiki agent run writer       # produces the first article
```

Each call blocks until the run finishes (typically 5-60 seconds). The output payload includes `duration_ms`, `steps`, `edits`, and `usage.totalTokens` so you can size the cost.

### Sanity-check the output

```bash
arkeon-wiki agent run writer --space <your-space>   # if not run inside the bound dir
curl -s http://localhost:8000/<your-space>/redlinks | jq .   # see queued articles
ls wiki/                                            # see what the writer produced
```

Open the result in a browser:

```
http://localhost:8000/<your-space>/
```

The reader page lists every article in the space; click through to see the writer's first output rendered with the article-relative links resolved.

**Don't proceed if the article isn't what you wanted.** This is the moment to tune `instructions:`. The agents will produce articles in this voice/structure for as long as the config stands; later corrections require either rewriting articles by hand or rolling back. Re-run `agent run writer` (after deleting the article and tweaking `instructions:`) until the output is what you'd be happy to read every hour.

## 8. Let cron carry it

Bundled cron defaults:

| Role | Cadence | Why |
|------|---------|-----|
| `editor` | hourly | Source-driven; new sources land slowly. |
| `proposer` | hourly | Trails editor by data dependency (gates on `editor.processed_hash` tag). |
| `writer` | every 15 min | Red-link queue-driven; the fastest mover. |

For the first day or two, **slow the writer down** so you can observe before the corpus gets large. Override in `.arkeon/agents.yaml`:

```yaml
roles:
  writer:
    cron: "0 */1 * * *"     # every hour instead of every 15 minutes
```

The change takes effect on the next tick — no daemon restart needed.

Read articles in the browser:

```
http://localhost:8000/<your-space>/
```

Red links show up in red; click through to see what the queue looks like. The `/<space>/redlinks` and `/<space>/recent` API routes give you the queue and the edit feed if you want to script alerts.

## 9. Daily-use commands

```bash
arkeon-wiki status                  # is the daemon up?
arkeon-wiki logs -f                 # tail the daemon log (includes agent runs)
arkeon-wiki ls                      # list running instances (rare unless --name)
arkeon-wiki search "shannon"        # ripgrep across the bound space
arkeon-wiki sources scan            # re-inventory after adding sources
arkeon-wiki config show             # what'll actually run
arkeon-wiki agent run <role>        # fire a tick on demand
arkeon-wiki down                    # stop the daemon
```

## Troubleshooting

**`fetch failed` from `init`.** No daemon is running on the URL `init` is targeting. Run `arkeon-wiki status` to check, and `arkeon-wiki up` to start one.

**Agents start spending money the moment the daemon is up.** True. The writer's default cron is every 15 min and will fire on any redlinks the proposer leaves behind. If you want to inspect before letting it loose, slow the writer to hourly (Step 8) before adding sources — the editor and proposer won't queue anything for the writer until they've each processed at least one source.

**My API key isn't being picked up.** Check the order: `~/.arkeon-wiki/.env` is read at daemon launch. If you added the key after `arkeon-wiki up`, restart with `arkeon-wiki down && arkeon-wiki up`. Shell `export` always wins, so `OPENAI_API_KEY=sk-... arkeon-wiki up` is another option.

**The editor logged "0 edits" — is it broken?** No. The editor only edits *existing* articles. On a corpus with zero or few articles, "0 edits" is the correct outcome. The proposer is the one that converts unprocessed sources into red links; the writer is the one that fills the queue. Run those two next.

**The writer produced one article and stopped.** That's the design — one article per tick. The next writer tick (in 15 min by default, or `arkeon-wiki agent run writer` immediately) drains the next red link.

**The voice is wrong / the structure is wrong / the articles are bland.** Tune `instructions:`. The single biggest lever in the system. If you want a fundamentally different article structure (different section names, different layout), override `roles.writer.system:` wholesale instead — `instructions:` layers onto the bundled prompt, it doesn't replace it.

**A source I want indexed isn't showing up.** Run `arkeon-wiki sources scan`. If it's in the `unsupported` bucket, convert it (see Step 6). If it's not in either bucket, it's probably under a hidden directory (anything starting with `.`) or inside `node_modules`, `.git`, etc. — the watcher skips those by design.

**Multiple daemons running confused things.** `arkeon-wiki ls` lists them. The default-port daemon (started by plain `up`) takes precedence; if you also have named instances (`up --name foo`), pass `--api-url http://localhost:<port>` to target a specific one.

## What's next

- **Customize the role pipeline**: add a custom role in `.arkeon/agents.yaml` (e.g., a `curator` that prunes stale articles, or a `synthesizer` that connects articles across themes). See [docs/user/AGENT_RUNTIME.md](./docs/user/AGENT_RUNTIME.md).
- **Run multiple wikis side by side**: register more directories with `arkeon-wiki init`. The daemon watches as many spaces as you point at.
- **Read the corpus a different way**: the `/<space>/search`, `/<space>/redlinks`, and `/<space>/recent` API endpoints expose the index. The reader UI in v0 is intentionally minimal — articles render as plain HTML pages.
