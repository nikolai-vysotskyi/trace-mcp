#!/usr/bin/env bash
# trace-mcp-reindex v0.1.0
# trace-mcp PostToolUse auto-reindex hook
# Triggers incremental reindex after Edit/Write/MultiEdit on code files.
# Runs `trace-mcp index-file <file>` in the background — non-blocking.
#
# Install: add to ~/.claude/settings.json or .claude/settings.local.json under PostToolUse
# See README.md for setup instructions.

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

# Reindex in background — non-blocking, silent
nohup trace-mcp index-file "$FILE_PATH" >/dev/null 2>&1 &

exit 0
