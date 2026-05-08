# trace-mcp VS Code extension

Auto-reindex on save for any MCP client running inside VS Code.

## Why

Claude Code triggers reindex via PostToolUse hooks after every file edit.
Other MCP clients running inside VS Code — Copilot Chat, Continue, Cline,
Roo Code — don't have an equivalent hook surface. Without this extension,
the trace-mcp index goes stale on every save and the agents start
returning yesterday's symbols.

This extension closes the gap by listening for `onDidSaveTextDocument`
and shelling out to the trace-mcp CLI per file, with a per-file debounce
so a flurry of saves collapses into one reindex call.

## Install

From source via VSIX:

```bash
cd packages/vscode-extension
pnpm install
pnpm build
npx @vscode/vsce package
code --install-extension trace-mcp-vscode-0.1.0.vsix
```

Marketplace publish is queued.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `traceMcp.enabled` | `true` | Suspend without uninstalling. |
| `traceMcp.commandPath` | `trace-mcp` | Absolute path needed if your install isn't on the GUI process's PATH (typical with pipx, asdf, or a Node version manager). |
| `traceMcp.debounceMs` | `500` | Per-file debounce window. |
| `traceMcp.excludeGlobs` | `["**/node_modules/**", ...]` | Workspace-relative glob patterns whose matches are skipped. |
| `traceMcp.languages` | TS/JS/Python/Go/Rust/Java/Kotlin/Scala/Ruby/PHP/C#/C/C++/Swift/Elixir/Vue/Svelte | Editor language IDs that trigger a reindex. |
| `traceMcp.timeoutMs` | `30000` | Wall-clock budget for the CLI call. |

## Commands

- **trace-mcp: Reindex current file** — re-runs the CLI on the active file ignoring debounce.
- **trace-mcp: Reindex entire workspace** — runs `register-edit .` for every workspace folder.

## Output channel

All spawn results, errors, and timeouts go to the **trace-mcp** output
channel. The extension never surfaces toast notifications for routine
reindex events — saves happen too often.
