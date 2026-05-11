#!/usr/bin/env bash
# trace-mcp-reindex v0.2.0
# trace-mcp PostToolUse auto-reindex hook
# Daemon-first: posts to the running daemon's /api/projects/reindex-file
# endpoint via curl (no Node startup). Falls back to a cold subprocess
# only when the daemon is unreachable.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME="${CLAUDE_TOOL_NAME:-$(echo "$INPUT" | jq -r '.tool_name // empty')}"

# Only handle edit-like tools
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" && "$TOOL_NAME" != "MultiEdit" ]]; then
  exit 0
fi

# Code file extensions to reindex
CODE_EXT_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|c|h|hpp|swift|scala|vue|svelte|astro|blade\.php)$'

# Non-code extensions — skip silently
NONCODE_EXT_RE='\.(md|json|jsonc|yaml|yml|toml|ini|cfg|env|txt|html|xml|csv|svg|lock|log|sh|bash|zsh|fish|ps1|bat|cmd|dockerfile|dockerignore|gitignore|gitattributes|editorconfig|prettierrc|eslintrc|stylelintrc)$'

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip non-code files
if echo "$FILE_PATH" | grep -qiE "$NONCODE_EXT_RE"; then
  exit 0
fi

# Skip if not a recognised code file
if ! echo "$FILE_PATH" | grep -qiE "$CODE_EXT_RE"; then
  exit 0
fi

# Resolve project root: prefer git toplevel, then walk up looking for
# .git or trace-mcp.config.json. Skip silently when the file isn't in a
# tracked project.
PROJECT_ROOT=""
FILE_DIR=$(dirname "$FILE_PATH")
if command -v git >/dev/null 2>&1; then
  PROJECT_ROOT=$(cd "$FILE_DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)
fi
if [[ -z "$PROJECT_ROOT" ]]; then
  dir="$FILE_DIR"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -d "$dir/.git" || -f "$dir/trace-mcp.config.json" ]]; then
      PROJECT_ROOT="$dir"
      break
    fi
    dir=$(dirname "$dir")
  done
fi
[[ -z "$PROJECT_ROOT" ]] && exit 0

# Daemon port: env override, then default 3741.
PORT="${TRACE_MCP_DAEMON_PORT:-3741}"

# Try daemon first — single curl, ~5 ms RTT. No Node startup.
if curl -fsS --max-time 2 -X POST \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg p "$PROJECT_ROOT" --arg f "$FILE_PATH" '{project:$p,path:$f}')" \
    "http://127.0.0.1:${PORT}/api/projects/reindex-file" >/dev/null 2>&1; then
  exit 0
fi

# Fallback: cold spawn (legacy behavior). Only hit when daemon is down.
nohup trace-mcp index-file "$FILE_PATH" >/dev/null 2>&1 &

exit 0
