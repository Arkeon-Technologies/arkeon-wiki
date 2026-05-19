# Using arkeon-wiki from Claude Desktop (MCP)

The `arkeon-wiki mcp` subcommand runs a Model Context Protocol (MCP) server over stdio. Wire it into Claude Desktop's `claude_desktop_config.json` and you get a slash-command surface for asking, capturing, and saving against your wiki without leaving the chat.

This doc assumes you already have a running daemon and at least one space registered. If not, see [SETUP.md](../../SETUP.md) first.

## How it works

The MCP server is a thin wrapper over the wiki's HTTP API. Each Claude Desktop entry **binds one wiki** via env vars — the MCP doesn't host a daemon, it talks to one. Run two wikis side by side? Two entries in `claude_desktop_config.json`, each pointing at a different port + space.

The "how to use the wiki" instructions ship as **MCP prompts**, not server-level instructions (which current clients don't surface). When you invoke a prompt from the slash-command menu, Claude gets the full per-mode flow in one shot.

## Configure Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Add one entry per wiki:

```json
{
  "mcpServers": {
    "iarpa": {
      "command": "arkeon-wiki",
      "args": ["mcp"],
      "env": {
        "ARKEON_WIKI_URL": "http://localhost:8186",
        "ARKEON_WIKI_SPACE": "iarpa",
        "ARKEON_WIKI_CALLER": "nick"
      }
    },
    "augustine-chesterton": {
      "command": "arkeon-wiki",
      "args": ["mcp"],
      "env": {
        "ARKEON_WIKI_URL": "http://localhost:8062",
        "ARKEON_WIKI_SPACE": "augustine-chesterton",
        "ARKEON_WIKI_CALLER": "nick"
      }
    }
  }
}
```

Env vars:

| Variable | Purpose | Default |
|---|---|---|
| `ARKEON_WIKI_URL` | Daemon API base URL | `http://localhost:8000` |
| `ARKEON_WIKI_SPACE` | Default space — tools accept an `space` override but rarely need one | none (tools error without it) |
| `ARKEON_WIKI_CALLER` | `X-Caller` header on writes (drives `entity_edits.by_role`) | `mcp` |

If `arkeon-wiki` isn't on your global `PATH` after a local install, use the absolute path in `command` (e.g. `/Users/you/.nvm/.../bin/arkeon-wiki`).

Restart Claude Desktop after editing the config.

## What you get

### Six prompts (slash-command menu)

| Prompt | When to use it |
|---|---|
| `mode-router` | Open-ended entry point. Tells Claude to auto-detect ASK / CAPTURE / FETCH / SAVE from your next message. |
| `new-space` | First-time setup of a new wiki space against the running daemon. Walks through name + watch_dir + the four "what's this wiki about" questions, calls `create_space`, drafts an `instructions:` block for you. |
| `ask` | Search the corpus and answer with inline citations to articles. |
| `capture` | Drop a thought, a pasted excerpt, or text extracted from an attachment into the wiki inbox — **verbatim**. |
| `fetch` | Pull a URL (or search-then-fetch a topic) and land its full text in the inbox. |
| `save` | Bundle the current exchange as a markdown source the editor agent will weave into articles. |

### Nine tools (Claude picks based on context)

- `daemon_status`, `list_spaces`, `create_space` — discovery + first-time setup
- `search_wiki`, `list_articles`, `read_article`, `list_redlinks` — read the corpus
- `capture_thought` — POST to `/inbox`
- `save_conversation` — PUT to `/sources/conversations/`

Tools accept a `space` argument that overrides the env-bound default — rarely needed, but useful if you want one MCP entry to query both wikis.

## Attachments: what's possible, what isn't

**You cannot pass an attached PDF's raw bytes through to an MCP tool.** MCP tool inputs are JSON-only by spec. There's no binary-content type, no client-side file passthrough, no `multipart/form-data` equivalent. This holds for both Claude Desktop (stdio) and Claude.ai web (HTTP custom connectors).

What works:

- **Text-extractable attachments** (PDF, .txt, .md, .docx): Claude reads the extracted text in its own context, then calls `capture_thought(text: "<the extracted text>")`. The `capture` prompt tells Claude to pass the **entire** extracted text, not a summary — the editor agent wants raw source material, not digests.
- **Mostly-visual content** (scans, images): Claude can describe / transcribe what it sees and capture that. The pixels themselves don't make it into the wiki.

For high-fidelity binary import (preserve formatting, images, layout), use the CLI path: convert with `pdftotext` or `pandoc` and drop the resulting `.txt` / `.md` file directly into the watch dir.

## Verifying the install

After restarting Claude Desktop:

1. Open a new chat — the MCP server entries should appear in the slash-command menu (often under "Tools" or "Connectors").
2. Type `/mode-router` and ask a simple question like "what's in the wiki?"
3. Claude should call `list_spaces` or `search_wiki` and reply with results.

If nothing shows up, check the Claude Desktop logs:

- macOS: `~/Library/Logs/Claude/mcp-server-<name>.log`
- Look for connection errors, "command not found" (your `arkeon-wiki` PATH issue), or daemon-unreachable messages.

You can also smoke-test from a terminal — the MCP server speaks JSON-RPC over stdio:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | arkeon-wiki mcp
```

You should see a JSON response containing `"serverInfo":{"name":"arkeon-wiki",...}` followed by the connection acknowledgment on stderr.

## Comparison: MCP vs. the `/iarpa` and `/philosoph` slash commands

The Claude Code CLI ships two skills (`/iarpa`, `/philosoph`) covering the same ASK / CAPTURE / SAVE / FETCH flows. The MCP server is the Claude Desktop equivalent — different surface, same flow doc backing it (`packages/arkeon/src/mcp/flows.ts`). Use whichever client you're in.

If you want a third surface (e.g. your own application) the flows are also documented in `/llms.txt` and `/help` against the running daemon.
