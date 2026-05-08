# trace-mcp Claude Code plugin

One-step install of the trace-mcp MCP server plus its guard and pre-compact hooks into Claude Code.

## What this plugin gives you

- **`trace-mcp` MCP server** registered automatically — code intelligence tools (search, get_outline, get_change_impact, apply_rename, scan_security, …) become available to the agent.
- **PreToolUse Bash guard** — blocks `ls` / `find` / `grep` / `cat` on source trees and routes the agent to trace-mcp's semantic tools instead. Saves tokens and produces better answers.
- **PreCompact session-snapshot injection** — when Claude Code compacts the conversation, the hook injects a Markdown snapshot (focus files, recent edits, key searches, dead ends) so the post-compact agent doesn't lose orientation.

## Prerequisites

`trace-mcp` must be installed on the system and resolvable on `PATH`:

```bash
npm install -g trace-mcp
trace-mcp init       # writes ~/.trace-mcp/launcher.env
```

The plugin's `mcpServers.trace-mcp.command` points at the `trace-mcp` binary, so Claude Code will spawn it directly. No extra wiring needed.

## Install

```bash
claude plugin install @nikolai-vysotskyi/trace-mcp
```

Or, manually, drop this directory next to your Claude Code config and add the plugin to `settings.json`.

## What gets installed

| File | Role |
|---|---|
| `plugin.json` | Plugin manifest (name, version, MCP server registration) |
| `.mcp.json` | MCP server entry consumed by Claude Code |
| `hooks/hooks.json` | Hook registrations (`PreToolUse:Bash`, `PreCompact`) |
| `marketplace.json` | Marketplace listing metadata |

The actual hook scripts live one level up in `hooks/` of the trace-mcp install (`${CLAUDE_PLUGIN_ROOT}/../hooks/`) so they are versioned with the npm package and updated on `npm i -g trace-mcp@latest`.

## Disabling individual hooks

If the Bash guard is too strict for your workflow, edit your project's `.claude/settings.local.json` and override the `PreToolUse:Bash` matcher to `false`. The MCP server itself stays active.
