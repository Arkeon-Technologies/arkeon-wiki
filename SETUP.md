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

**A trap worth flagging up front**: `defaults.model` is silently ignored for the bundled `editor`, `proposer`, and `writer` roles, because each bundled template has its own `model:` field that takes precedence in the resolution chain. To actually change the model for a bundled role, override it per role:

```yaml
roles:
  editor:
    model: gpt-5-mini
  proposer:
    model: gpt-5-mini
  writer:
    model: gpt-5-mini
```

`defaults.model` does apply to any *custom* role you define (that has no bundled template). Operator-defaults vs. bundled-template precedence is tracked in [#148](https://github.com/Arkeon-Technologies/arkeon-wiki/issues/148).

Concrete worked example — a wiki built on Augustine and G. K. Chesterton, attacking specific modern phenomena (transhumanism, AI companionship, productivity culture, etc.) through their critique of pure reason. The biggest lever is **insisting articles name a modern target by name** and refusing generic concept-exposition:

```yaml
defaults:
  provider: openai
  instructions: |
    This wiki uses Augustine and G. K. Chesterton as weapons
    against specific 21st-century anxieties, technologies, and
    prides. It is not a wiki *about* Augustine and Chesterton —
    generic exposition of their concepts is out of scope.

    Every article names a modern target by name and submits it to
    the authors' diagnosis. Anchor on the things that actually
    shape contemporary life: dating apps, AI companions,
    doomscrolling, hustle culture, parasocial relationships,
    secular mindfulness, optimization culture, longtermism,
    "follow your passion," the loneliness epidemic, productivity
    theology, scientism, AI doomerism, "live your truth."

    Slug shape: name the target by name.

      GOOD:  is-ai-companionship-the-new-manichaeism.html
      GOOD:  what-would-chesterton-say-about-tinder.html
      GOOD:  how-augustine-explains-doomscrolling.html
      GOOD:  why-self-actualization-is-cain-not-abel.html

      BAD:   why-is-orthodoxy-revolutionary.html
      BAD:   how-do-paradoxes-save-ethics.html
      BAD:   why-must-god-be-transcendent.html

    The BAD examples are generic concept articles. They explain
    what the authors thought; they do not deploy it against
    anything. Do not write them.

    Article shape (Question / Current answer / Evidence / Open
    threads — unchanged):
      Question: name the modern thing. State the unspoken modern
        assumption about it. Frame the question as "what does
        this assumption conceal?"
      Current answer: the authors' diagnosis, tied directly to
        the named modern thing. No generic theory.
      Evidence: inline citations to the sources (book + section
        where possible). Each quote should be connected to the
        modern target by name in the same paragraph — not just
        paraphrased into encyclopedia voice.
      Open threads: two or three OTHER modern phenomena the same
        diagnosis would touch, as red links.

    Tone:
      Polemical, sharp, partial. The reader should finish each
      article with the feeling that something they assumed is
      now in question. Hedging is forbidden — no "some have
      argued" or "on the other hand."

    Out of scope:
      Generic exposition of the authors' concepts.
      Apologetics primers — assume the reader knows the basics.
      Both-sides framing.

    Audience:
      Practitioners of contrarian thought who use these authors
      as weapons against modern certainties. Not students.

roles:
  editor:    { model: gpt-5-mini }
  proposer:  { model: gpt-5-mini }
  writer:    { model: gpt-5-mini }
```

The `GOOD/BAD` slug examples are the single most useful lever — they shape the proposer's red-link slugs, which then constrain the writer's article titles, which constrains the writer's voice. Get this right and the wiki develops a point of view from the first article on.

Verify the parse + the merged config:

```bash
arkeon-wiki config validate
arkeon-wiki config show
```

The `instructions:` text will appear under `defaults:` in the `config show` output.

## 6. Add your sources

Drop text files anywhere in the directory (any subfolder is fine — `sources/`, `notes/`, top-level, doesn't matter). The watcher picks them up automatically.

**What gets indexed**: nearly everything. Files split into two kinds:

- **`kind='text'`** — corpus material the agents read and process. Wikis (always text), plus source files classified as text: `.txt`, `.html`, `.md`, `.json`, `.csv`, `.yaml`, `.log`, `.rst`, `.tex`, and most source-code extensions. (Full list: `TEXT_EXTENSIONS`.) Unknown extensions get a content sniff — first 8 KB without a NUL byte → text. This is the queue-eligible kind.

- **`kind='asset'`** — binary attachments (PDFs, DOCX, images, audio, video, archives, fonts). Indexed so `<img src="chart.png">` and `<a href="report.pdf">` resolve to real entities instead of red links, but never enter the agent queues. Agents can still fetch and read them via the `fetch` tool (images and PDFs).

The only files refused outright are **secrets and OS junk** — `.env`, `.envrc`, `.pem`/`.p12`/PGP keys, `.swp`/`.tmp`/`.bak`, `.DS_Store`, `Thumbs.db`. (Full lists: `SKIP_EXTENSIONS` and `SKIP_BASENAMES` in `src/server/lib/fs-watcher.ts`.)

Wikis themselves are still authored in HTML only; everything described here is for *source* material the agents read or link to.

> **Heads-up — source code is indexed too.** `.ts`, `.py`, `.go`, `.rs`, `.java`, `.sh`, `.sql`, CSS, and most other source-code extensions live in `TEXT_EXTENSIONS`. If you point arkeon-wiki at a project root (e.g. `~/projects/my-app`), expect every file outside `node_modules`/`.git`/etc. to land in the index — including the codebase itself. That's intentional (agents can reason over code-as-source), but it means a "personal knowledge base" watch dir and a "checked-out repo" watch dir behave very differently. Use `arkeon-wiki sources scan` to preview before letting the daemon loose.

### Prefer chapters / sections over whole books

One source file = one editor tick = one proposer tick. Two practical consequences:

- **Size**: every tick reads the source in full. A 1 MB+ file can overflow the model's effective context (we hit this with a full Augustine *City of God* volume on `gpt-5-mini`). Aim for under ~150 KB per source — most chapters or essay-length pieces fit easily.
- **Granularity**: chapters give the proposer focused thematic territory to mine. A whole book covering 20 themes yields one plan wiki with 5 red links (most of the book's questions get compressed away); the same book split into 20 chapters yields 20 plan wikis, each surfacing the specific questions of that chapter.

So if you've grabbed a book, split it by chapter or by argument-section before letting the agents see it. A typical layout:

```
sources/
  augustine/
    confessions/
      book-01.txt
      book-02.txt
      ...
    city-of-god/
      book-01.txt
      ...
  chesterton/
    orthodoxy/
      ch-01-introduction.txt
      ch-02-the-maniac.txt
      ch-03-the-suicide-of-thought.txt
      ...
```

A simple `pandoc` or Python regex splitter on chapter headings is usually enough. Each chapter file ends up 10-100 KB, well within context limits.

### Convert binaries to text

Check what the watcher actually sees:

```bash
arkeon-wiki sources scan
```

The output partitions every file into supported / unsupported. Unsupported entries list up to 5 example paths per extension. Convert anything you wanted indexed:

| Source | Recommended converter |
|--------|----------------------|
| PDF | `pdftotext file.pdf file.txt` (poppler-utils) |
| DOCX | `pandoc file.docx -o file.md` |
| PPTX | `pandoc file.pptx -o file.md` |
| XLSX | export per sheet to `.csv`, or `pandoc -t csv` per sheet |
| Markdown | already supported — drop `.md` files directly |
| HTML web pages | save as `.html` outside `wiki/`, or use `pandoc` to clean |
| EPUB | `pandoc file.epub -o file.md` |

Anything text-shaped that lands in the watch dir gets indexed without conversion — even files with no extension or unfamiliar suffixes. Conversion is only needed for binary formats (the rows above).

Install the converters if you don't have them: `brew install pandoc poppler` on macOS, `apt install pandoc poppler-utils` on Debian/Ubuntu, or equivalents for your package manager.

A re-run of `sources scan` after conversion confirms zero unsupported files.

## 7. First-cycle smoke test

Three roles cooperate, in order:

- **`editor`** reads one source per tick and adds citations / open-thread red links to *existing* articles. On a fresh corpus with no articles yet, it tags-and-skips. **0 edits is the expected first-tick outcome — don't panic.**
- **`proposer`** picks up the source the editor just tagged, identifies questions no article covers yet, and emits them as red links in a per-source plan wiki at `wiki/_plans/<source-path>.html`. **An empty plan is also expected behavior**: when a new source's themes overlap with red links the queue already has, the proposer correctly refuses to duplicate them and emits an empty `<ul>`. That means the editor will instead integrate this source as citations into existing articles on subsequent ticks.
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

For the first day or two, **slow the writer down** so you can observe before the corpus gets large. Or for a fresh-corpus burst, speed all three up so you can watch the system fill in. Override in `.arkeon/agents.yaml`:

```yaml
roles:
  writer:
    cron: "0 */1 * * *"     # every hour instead of every 15 minutes

  # Or, for the initial-burst case:
  editor:
    cron: "*/3 * * * *"     # every 3 minutes
  proposer:
    cron: "*/3 * * * *"     # every 3 minutes
```

**Cron changes require a daemon restart** (`arkeon-wiki down && arkeon-wiki up`). The scheduler captures cron values at startup. Most other config — `instructions:`, `system:`, `tools:`, `model:` — hot-reloads on every tick, so edits to those land in seconds.

**Editor source-order**: with `sort: updated_at`, the editor picks whichever source was most recently updated (synced or touched). If you bulk-imported and the editor keeps grinding through the same corner of the corpus, give a specific file a nudge to jump the queue:

```bash
printf "\n" >> sources/path/to/the/one/you-want-next.txt
```

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

**Articles are too abstract — they explain concepts instead of attacking modern things.** Your `instructions:` need explicit GOOD/BAD slug examples and a "every article must name a 21st-century target by name" rule. The proposer follows the slug-shape patterns you give it; the writer follows the titles the proposer emits. See the worked example in Step 5.

**A source I want indexed isn't showing up.** Run `arkeon-wiki sources scan`. If it's in the `unsupported` bucket, convert it (see Step 6). If it's not in either bucket, it's probably under a hidden directory (anything starting with `.`) or inside `node_modules`, `.git`, etc. — the watcher skips those by design.

**`context_length_exceeded` 500 from `agent run`.** The source the agent picked is too big for the model's effective context. Split that source into chapters (see Step 6 — "Prefer chapters / sections over whole books"). If you can't split it for some reason, switch the affected role to a model with a larger context window (`roles.editor.model: ...`, etc. — and remember to restart the daemon if you also changed cron values).

**The editor keeps picking the same corner of my corpus.** `sort: updated_at` means whichever sources were touched most recently get picked first. After a bulk import, the order is deterministic but often unintuitive. Bump a specific file with `printf "\n" >> sources/.../that-one.txt` to jump it to the front of the queue.

**My `model:` change isn't taking effect.** `defaults.model` is silently ignored for the bundled `editor`, `proposer`, and `writer` roles — each bundled template has its own `model:` that wins. Override per-role under `roles:` (see Step 5).

**The proposer created an empty plan wiki (no red links inside).** That's correct, not broken. The proposer refuses to emit red links that duplicate themes already covered by existing articles or queued red links. On the next editor tick, the same source will be integrated as citations into existing articles instead. Empty plans tend to appear on the 2nd, 3rd, etc. source of a thematically-cohesive corpus.

**Multiple daemons running confused things.** `arkeon-wiki ls` lists them. To target a specific one, pass `--api-url http://localhost:<port>` (the port for a named daemon is printed by `arkeon-wiki up --name <name>` and visible in `ls`). If `init` is hitting the wrong daemon — see [#144](https://github.com/Arkeon-Technologies/arkeon-wiki/pull/144) for auto-discovery, after which plain `arkeon-wiki up` (no `--name`) is preferred and `init` will find it automatically.

## What's next

- **Customize the role pipeline**: add a custom role in `.arkeon/agents.yaml` (e.g., a `curator` that prunes stale articles, or a `synthesizer` that connects articles across themes). See [docs/user/AGENT_RUNTIME.md](./docs/user/AGENT_RUNTIME.md).
- **Run multiple wikis side by side**: register more directories with `arkeon-wiki init`. The daemon watches as many spaces as you point at.
- **Read the corpus a different way**: the `/<space>/search`, `/<space>/redlinks`, and `/<space>/recent` API endpoints expose the index. The reader UI in v0 is intentionally minimal — articles render as plain HTML pages.
