// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

// Canonical "how to use this MCP server" flow doc. Exported as named
// strings so prompt handlers can compose them. The /iarpa and /philosoph
// Claude Code skills cover the same ground in skill-markdown form; this
// is the MCP equivalent and the two are kept in sync by convention.
//
// Each export is the full body of one prompt. Keep them tight — every
// byte ships back to the model on each prompt invocation.

export const NEW_SPACE_FLOW = `# New space — set up a wiki against this arkeon-wiki daemon

The daemon is already running. Your job: register a fresh wiki space against it and help the user opinionate it.

## Step 1 — Confirm the daemon is reachable

Call \`daemon_status\`. If \`ok: false\`, stop and tell the user to run \`arkeon-wiki up\` (or restart their installed service). Do not try to start it yourself.

## Step 2 — Gather the four SETUP.md-step-5 questions

Ask the user, one at a time or all four together, depending on their style:

1. **What is the wiki about — and what is it _not_ about?** (e.g. "Augustine + Chesterton as critique of 21st-century anxieties; not a primer on the authors")
2. **What kinds of articles should be written?** (Surveys? Question-and-answer? Polemics? Concept reference?)
3. **What voice?** (Encyclopedia-neutral / opinionated / contrarian / primary-source / etc.)
4. **Who's the audience?** (Practitioners / newcomers / you-six-months-from-now / etc.)

Don't write the wiki's instructions for them — those answers will land in \`.arkeon/agents.yaml\` and shape every article the agents produce.

## Step 3 — Propose a name and watch_dir

The space \`name\` becomes the URL slug (\`http://localhost:<port>/<name>/\`). Short, lowercased, hyphenated.

The \`watch_dir\` is where source files and the generated \`wiki/\` will live on disk. Common patterns:

- \`~/Documents/wikis/<name>\` (personal knowledge base)
- \`~/projects/<name>-wiki\` (project-scoped, lives next to a codebase)

Confirm both with the user before creating.

## Step 4 — Create the space

**REQUIRED confirmation step**: before calling create_space, restate the exact \`name\` and \`watch_dir\` you plan to register and ask the user to confirm with a literal "yes" / "go ahead" / similar. Do not infer consent from earlier conversation — get an explicit ack against the final values. \`watch_dir\` will index every text file under that directory; the wrong path (e.g. a home directory or a secrets folder) makes private content searchable.

After the user confirms in plain text, call \`create_space\` with \`{ name, watch_dir }\`. The daemon registers the dir and starts the file watcher immediately. \`.arkeon/state.json\` is NOT written by this tool (that's a CLI-only side-effect of \`arkeon-wiki init\`) — note that if the user plans to drive the wiki from the CLI later, they should also run \`arkeon-wiki init\` in the dir to get the local state file and a starter \`.arkeon/agents.yaml\`.

## Step 5 — Suggest the \`instructions:\` block

Draft a starter \`defaults.instructions:\` block from the user's answers in step 2 and show it to them. They paste it into \`.arkeon/agents.yaml\`. Without this block the agents will write a generic encyclopedia; with it, the corpus develops a point of view.

Use the SETUP.md worked example (Augustine + Chesterton attacking modern targets by name) as a template if the user wants something concrete.

## Step 6 — Tell them how to feed it

- Drop text files anywhere in the watch_dir (sources/, notes/, top-level — the watcher picks it up).
- Binaries (PDFs, DOCX) need conversion first: \`pdftotext file.pdf file.txt\` or \`pandoc file.docx -o file.md\`.
- Chapters > whole books — one file is one editor tick.
- Use \`capture_thought\` to drop a note straight into the inbox without leaving the chat.
`;

export const ASK_FLOW = `# Ask the wiki

The user is asking a question of the corpus. Find relevant articles, read them, answer with inline citations.

## Step 1 — Search

Call \`search_wiki\` with 1-3 thematic noun phrases (ripgrep ORs them in one pass). Filter to \`type=wiki\`. Limit ~15.

If the corpus uses different vocabulary than the user's question, fall back to \`list_articles\` with \`label_contains=<concept>\` — keyword search misses paraphrase, the label/short_description filter catches it.

## Step 2 — Read the top 1-4 articles in full

Call \`read_article\` ONCE with a \`paths\` array containing all the candidates (e.g. \`paths: ["wiki/foo.html", "wiki/bar.html", "wiki/baz.html"]\`). The tool fetches them in parallel — batching is dramatically faster than calling read_article multiple times. Prefer fewer deeper reads to many shallow ones — the user wants an answer grounded in the wiki, not a headline summary.

## Step 3 — Answer

Lead with the claim. Cite each source inline using **clickable markdown links** to the frontend so the user can drill in:

\`\`\`markdown
- The current empirical state is **rough parity** ([current-state-kg-vs-rag](http://localhost:<port>/<space>/wiki/current-state-kg-vs-rag.html)).
- That picture started shifting after the 49/53 finding ([kg-vs-rag-belief-arc](http://localhost:<port>/<space>/wiki/kg-vs-rag-belief-arc.html)).
\`\`\`

If the wiki doesn't have the answer, **say so honestly**. Don't hallucinate from general knowledge. Offer to capture the user's framing as a thought (transitions to capture) or fetch a source on the topic (transitions to fetch).

## Step 4 — Leave the door open

Single line: "Save this exchange to the corpus? Reply \`save\` or just keep going." Don't badger. If the user asks another question, just answer it.
`;

export const CAPTURE_FLOW = `# Capture a thought into the wiki inbox

The user is dumping a thought, an external article they're reading, a paste from somewhere, or text extracted from an attachment. Land it in the inbox so the editor agent picks it up at the next tick.

## Critical: preserve content verbatim

**Pass as much of the original content as possible, verbatim.** That includes:

- The user's exact wording — do not paraphrase, summarize, or "tighten" their thoughts.
- Any quoted material from a source they're discussing — quote it in full, not paraphrased.
- The surrounding conversational context if it shapes the meaning (e.g. "I was just talking to X about Y when I realized…" — keep the framing).
- If extracting from an attachment (PDF / image / pasted document), include the entire extracted text, not a summary of it. The editor agent will mine it for citations and questions; summarization at this stage destroys the raw material the corpus is built from.

The capture flow is the corpus's intake valve. Err heavily toward more content. Storage is cheap; lost nuance is not.

## Step 1 — Build a title

Tight (max ~10 words). If the user led with \`note: <title>\` or \`thought: <title>\`, use that. Otherwise generate from the first sentence — focus on the subject, not "Note about…". Title the *thing*, not the act of noting it.

## Step 2 — Call capture_thought

\`capture_thought({ title, text, kind: "md" })\` — kind defaults to "md" so you can format with headings and quotes if useful. The full verbatim content goes in \`text\`.

## Step 3 — Confirm tersely

> Captured → \`<returned path>\` · editor picks it up at the next tick

Do NOT echo the full thought back. The user already wrote it.

## Step 4 — Stay open

Drop back to listening for the next thing. The user may capture multiple thoughts in a row, switch to asking, etc.
`;

export const SAVE_FLOW = `# Save the current exchange as a wiki source

Bundle the current conversation (questions, answers, captures, fetches) as a markdown document and PUT it under \`sources/conversations/\` so the editor agent weaves it into articles on subsequent ticks.

## Step 1 — Compose the transcript

Format:

\`\`\`markdown
# <derived title — the question or topic, max 12 words>

**Date**: <UTC YYYY-MM-DD>
**Participants**: <user> + claude (arkeon-wiki MCP)

## Question
<user's question, verbatim>

## Answer
<your answer, with the same inline citations to wiki articles>

## Notes / follow-ups
<any clarifications, captures, or back-and-forth that followed>
\`\`\`

For multi-round exchanges: \`## Round 1 — Question\` / \`## Round 1 — Answer\` / \`## Round 2 — Question\` etc.

**Preserve verbatim**: like capture, save what was actually said. Don't summarize the user's questions; don't tighten your own prose. The editor wants the conversation, not a digest of it.

## Step 2 — Build the path

\`sources/conversations/YYYY-MM-DD-HHMM-<slug>.md\` — UTC date+time, slug from the title (lowercase, hyphens, alphanumeric only, max ~50 chars). The HHMM prefix prevents same-day collisions.

## Step 3 — PUT it

\`save_conversation({ slug, transcript })\` — the tool builds the date-stamped path under \`sources/conversations/\` for you. On 409 (collision), it auto-suffixes \`-2\`, \`-3\`, etc.

## Step 4 — Confirm

> Saved → \`<returned path>\` · view at http://localhost:<port>/<space>/sources/conversations/<file>.md
`;

export const FETCH_FLOW = `# Fetch an external source into the wiki

The user wants something from the web pulled into the corpus. Two sub-flows.

## A. Direct URL

The user pasted an \`http(s)://\` URL.

1. Use the **WebFetch** tool (provided by Claude itself, not this MCP) to extract clean article text. Prompt WebFetch with: "Extract the article's full body text without navigation, ads, or footer. Preserve paragraphs. Return as plain text including the title/byline."
2. Pass the cleaned text through to \`capture_thought({ title: <article title>, text: <full extracted text> + "\\n\\n---\\nSource: <URL>\\nFetched: <UTC date>" })\`. The footer lets the editor trace provenance later.
3. **Pass all of the extracted text, not a summary.** The wiki agents need the source material whole.

## B. Search-then-fetch

The user asked for content on a topic without a URL ("find me something on AI companionship"):

1. Use **WebSearch** for 3-5 candidates.
2. Show the candidates as a numbered list: title + source + one-line description.
3. Wait for the user to pick one (or "all" / "skip" / refine).
4. WebFetch the chosen URL(s).
5. \`capture_thought\` each (same shape as direct URL).

Don't auto-fetch without confirmation — the wiki's editorial direction is shaped by which sources land in it. That's the user's call.

## What NOT to fetch

- Paywalled / login-required content — WebFetch returns a login wall. Tell the user, offer to paste the full text via \`capture_thought\` instead.
- SPA shells with no real content.
- Anything that isn't text (the inbox rejects content with NUL bytes).
`;

export const MODE_ROUTER = `# Use the arkeon-wiki MCP

You have tools for reading and writing to a local arkeon-wiki space:

- \`daemon_status\` — is the daemon alive?
- \`list_spaces\` / \`create_space\` — discovery + first-time space setup
- \`search_wiki\` / \`list_articles\` / \`read_article\` — read the corpus
- \`list_redlinks\` — see what articles the wiki "wants next"
- \`capture_thought\` — dump a thought / pasted content / extracted attachment text into the inbox
- \`save_conversation\` — bundle this exchange as a source the agents will weave into articles

## Detect mode from the user's input

| Signal | Mode |
|---|---|
| Empty / "what can you do" | Ask the user what they want |
| Question (\`?\`, or starts with who/what/how/why/when/where/which/can/does/should/is/are) | **ASK** — search + read + cite |
| Starts with \`note:\` / \`thought:\` / \`capture:\` / \`dump:\` / \`idea:\` OR is a multi-sentence first-person assertion | **CAPTURE** — preserve verbatim, capture_thought |
| Contains a URL OR starts with \`find\` / \`fetch\` / \`pull\` | **FETCH** — WebFetch then capture_thought |
| Literal \`save\` / \`save this\` / "add to corpus" | **SAVE** — save_conversation |
| User wants to set up a new wiki | Call the \`new-space\` prompt |
| Ambiguous | Ask which mode they want |

For full per-mode instructions, invoke the \`ask\`, \`capture\`, \`save\`, or \`fetch\` prompts. Each prompt expands into the full flow for that mode.

## Critical reminder for capture + save

**Preserve content verbatim.** The wiki's value comes from the raw source material reaching the editor agent intact. Do not summarize, tighten, or paraphrase what the user (or their attachments / pasted sources) says. Pass it through whole — title is yours to write, body is theirs.
`;

// Tool-level short descriptions (for the inputSchema description field).
// These are duplicated into the registered tool definitions in tools/*.ts;
// the prompts above are the long-form versions.
export const TOOL_DESCRIPTIONS = {
  capture_thought:
    "POST a thought, pasted excerpt, or extracted attachment text into the wiki's inbox so the editor agent picks it up. Preserve content verbatim — do not summarize, paraphrase, or tighten the user's words or any quoted source material. The editor wants raw input, not a digest.",
  save_conversation:
    "PUT the current conversation (verbatim — questions, answers, captures) as a markdown source under sources/conversations/. The editor agent weaves it into articles on subsequent ticks. Preserve exact wording; do not summarize the exchange.",
} as const;
