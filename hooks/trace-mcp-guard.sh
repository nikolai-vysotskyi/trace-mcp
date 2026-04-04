#!/usr/bin/env bash
# trace-mcp-guard v0.1.0
# trace-mcp PreToolUse guard
# Blocks Read/Grep/Glob/Bash on source code files → redirects to trace-mcp tools.
# Allows: non-code files, Read before Edit, safe Bash commands (git, npm, build, test).
#
# Install: add to ~/.claude/settings.json or .claude/settings.local.json
# See README.md for setup instructions.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME="${CLAUDE_TOOL_NAME:-$(echo "$INPUT" | jq -r '.tool_name // empty')}"

# Code file extensions to guard
CODE_EXT_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|c|h|hpp|swift|scala|vue|svelte|astro|blade\.php)$'

# Non-code extensions — always allow
NONCODE_EXT_RE='\.(md|json|jsonc|yaml|yml|toml|ini|cfg|env|txt|html|xml|csv|svg|lock|log|sh|bash|zsh|fish|ps1|bat|cmd|dockerfile|dockerignore|gitignore|gitattributes|editorconfig|prettierrc|eslintrc|stylelintrc)$'

# Safe bash command prefixes — never block
SAFE_BASH_RE='^(git |npm |npx |pnpm |yarn |bun |node |deno |cargo |go |make |mvn |gradle |docker |kubectl |helm |terraform |pip |poetry |uv |pytest |vitest |jest |phpunit |composer |artisan |rails |bundle |mix |dotnet |cmake |ninja |meson )'

deny() {
  local reason="$1"
  local context="$2"
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "$reason",
    "additionalContext": "$context"
  }
}
EOF
  exit 0
}

# Track denied reads — allow on second attempt (agent needs it for Edit)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "default"')
DENY_DIR="/tmp/trace-mcp-guard-${SESSION_ID}"
mkdir -p "$DENY_DIR" 2>/dev/null

# --- Read ---
if [[ "$TOOL_NAME" == "Read" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

  # Allow non-code files
  if echo "$FILE_PATH" | grep -qiE "$NONCODE_EXT_RE"; then
    exit 0
  fi

  # Allow files outside source dirs (configs in root, etc.)
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" != *.* ]] || echo "$FILE_PATH" | grep -qE '(node_modules|vendor|dist|build|\.git)/'; then
    exit 0
  fi

  # Block code file reads → redirect to trace-mcp
  if echo "$FILE_PATH" | grep -qiE "$CODE_EXT_RE"; then
    # Allow on second attempt — agent needs full content for Edit
    DENY_MARKER="$DENY_DIR/$(echo "$FILE_PATH" | md5sum | cut -d' ' -f1)"
    if [[ -f "$DENY_MARKER" ]]; then
      rm -f "$DENY_MARKER"
      exit 0
    fi
    touch "$DENY_MARKER"

    REL_PATH=$(echo "$FILE_PATH" | sed "s|^$(pwd)/||")
    deny \
      "Use trace-mcp for code reading — it returns only what you need, saving tokens." \
      "trace-mcp alternatives for ${REL_PATH}:\\n- get_outline { \\\"path\\\": \\\"${REL_PATH}\\\" } — see file structure (signatures only)\\n- get_symbol { \\\"fqn\\\": \\\"SymbolName\\\" } — read one specific symbol\\n- search { \\\"query\\\": \\\"keyword\\\" } — find symbols by name\\n- get_feature_context { \\\"description\\\": \\\"what you need\\\" } — relevant code for a task\\nIf you need full file content before editing, retry Read — it will be allowed."
  fi

  exit 0
fi

# --- Grep ---
if [[ "$TOOL_NAME" == "Grep" ]]; then
  GREP_PATH=$(echo "$INPUT" | jq -r '.tool_input.path // empty')
  GREP_GLOB=$(echo "$INPUT" | jq -r '.tool_input.glob // empty')
  GREP_TYPE=$(echo "$INPUT" | jq -r '.tool_input.type // empty')

  # Allow grep on non-code file types
  if echo "$GREP_GLOB" | grep -qiE '\.(md|json|ya?ml|toml|env|txt|html|xml|csv|cfg|ini|lock|log)'; then
    exit 0
  fi

  # Allow grep on non-code type filter
  if [[ "$GREP_TYPE" == "md" || "$GREP_TYPE" == "json" || "$GREP_TYPE" == "yaml" || "$GREP_TYPE" == "toml" || "$GREP_TYPE" == "xml" || "$GREP_TYPE" == "html" || "$GREP_TYPE" == "csv" ]]; then
    exit 0
  fi

  # Allow grep on config dirs
  if echo "$GREP_PATH" | grep -qE '(node_modules|vendor|dist|build|\.git)'; then
    exit 0
  fi

  PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')
  deny \
    "Use trace-mcp for code search — it understands symbols and relationships." \
    "trace-mcp alternatives for searching \\\"${PATTERN}\\\":\\n- search { \\\"query\\\": \\\"${PATTERN}\\\" } — find symbols by name (supports kind, language, file_pattern filters)\\n- find_usages { \\\"fqn\\\": \\\"SymbolName\\\" } — find all usages (imports, calls, renders)\\n- get_call_graph { \\\"fqn\\\": \\\"FunctionName\\\" } — who calls it + what it calls\\nUse Grep only for non-code files (.md, .json, .yaml, config)."

fi

# --- Glob ---
if [[ "$TOOL_NAME" == "Glob" ]]; then
  GLOB_PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')

  # Allow glob for non-code patterns
  if echo "$GLOB_PATTERN" | grep -qiE '\.(md|json|ya?ml|toml|env|txt|html|xml|csv|cfg|ini|lock|log)'; then
    exit 0
  fi

  deny \
    "Use trace-mcp for code file discovery — it knows your project structure." \
    "trace-mcp alternatives:\\n- get_project_map { \\\"summary_only\\\": true } — project overview (frameworks, languages, structure)\\n- search { \\\"query\\\": \\\"keyword\\\", \\\"file_pattern\\\": \\\"src/tools/*\\\" } — find symbols in specific paths\\n- get_outline { \\\"path\\\": \\\"path/to/file\\\" } — see what\\'s in a file\\nUse Glob only for non-code file patterns."

fi

# --- Bash ---
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

  # Allow safe commands
  if echo "$COMMAND" | grep -qE "$SAFE_BASH_RE"; then
    exit 0
  fi

  # Block code exploration via bash (grep, find, cat, head, tail on code files)
  if echo "$COMMAND" | grep -qE '(^|\|)\s*(grep|rg|find|cat|head|tail|less|more|awk|sed)\s' && echo "$COMMAND" | grep -qiE "$CODE_EXT_RE"; then
    deny \
      "Use trace-mcp instead of shell commands for code exploration." \
      "trace-mcp has structured tools for this:\\n- search — find symbols by name\\n- get_symbol — read a specific symbol\\n- get_outline — file structure\\n- find_usages — all usages of a symbol\\nUse Bash only for builds, tests, git, and system commands."
  fi

  exit 0
fi

# Allow everything else
exit 0
