# trace-mcp Codex CLI plugin

One-step install of the trace-mcp MCP server plus its Bash guard hook into Codex CLI.

## What this plugin gives you

- **`trace-mcp` MCP server** registered automatically — code intelligence tools (search, get_outline, get_change_impact, apply_rename, scan_security, …) become available to the agent.
- **PreToolUse Bash guard** — blocks `ls` / `find` / `grep` / `cat` on source trees and routes the agent to trace-mcp's semantic tools instead. Saves tokens and produces better answers.

Codex has no PreCompact-equivalent lifecycle event, so the Claude Code plugin's pre-compact session-snapshot hook (see `../.claude-plugin/README.md`) is not part of this plugin.

## Prerequisites

`trace-mcp` must be installed on the system and resolvable on `PATH`:

```bash
npm install -g trace-mcp
trace-mcp init       # writes ~/.trace-mcp/launcher.env
```

The plugin's `mcpServers` entry points at the `trace-mcp` binary, so Codex will spawn it directly. No extra wiring needed.

## Install

```bash
codex plugin marketplace add nikolai-vysotskyi/trace-mcp
codex plugin install trace-mcp@nikolai-vysotskyi-trace-mcp
```

Or, manually, drop this directory next to your Codex config and add the plugin to your Codex config.

## What gets installed

| File | Role |
|---|---|
| `plugin.json` | Plugin manifest (name, version, MCP server + hooks references) |
| `.mcp.json` | MCP server entry consumed by Codex |
| `hooks/hooks.json` | Hook registration (`PreToolUse:Bash`) |
| `marketplace.json` | Marketplace listing metadata |

The actual hook script lives one level up in `hooks/` of the trace-mcp install (`${PLUGIN_ROOT}/../hooks/`) so it is versioned with the npm package and updated on `npm i -g trace-mcp@latest`.

## Known gaps

The Bash guard hook is shared verbatim with the Claude Code plugin (`hooks/trace-mcp-guard.sh`), which was written and tested against Claude Code's `PreToolUse` hook output contract (`permissionDecision` JSON). Codex documents `PLUGIN_ROOT`/`PLUGIN_DATA` with `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` kept as legacy aliases specifically for this kind of cross-tool reuse, so the schema is expected to match, but it has not yet been verified against a real Codex CLI install. Please file an issue if the guard misbehaves under Codex.
