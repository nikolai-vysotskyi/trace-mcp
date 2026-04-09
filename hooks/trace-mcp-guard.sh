#!/usr/bin/env bash
# trace-mcp-guard v0.6.0
# trace-mcp PreToolUse guard
# Blocks Read/Grep/Glob/Bash on source code files → redirects to trace-mcp tools.
# Allows: non-code files, Read before Edit, safe Bash commands (git, npm, build, test).
#
# Consultation markers: trace-mcp server writes markers when tools access files
# (get_outline, get_symbol, etc.). If a marker exists for a file, Read is allowed
# immediately — the agent already consulted trace-mcp for this file.
#
# Repeat-read dedup (v0.6.0): tracks per-session allowed reads of each code file.
# After 2 allowed reads of an unchanged file, subsequent reads are denied with a
# redirect to get_symbol/get_outline. Edits (mtime change) reset the counter.
#
# Install: add to ~/.claude/settings.json or .claude/settings.local.json
# See README.md for setup instructions.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME="${CLAUDE_TOOL_NAME:-$(echo "$INPUT" | jq -r '.tool_name // empty')}"

# Code file extensions to guard
CODE_EXT_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|c|h|hpp|swift|scala|vue|svelte|astro|blade\.php)$'

# Non-code extensions — always allow
NONCODE_EXT_RE='\.(md|json|jsonc|yaml|yml|toml|ini|cfg|txt|html|xml|csv|svg|lock|log|sh|bash|zsh|fish|ps1|bat|cmd|dockerfile|dockerignore|gitignore|gitattributes|editorconfig|prettierrc|eslintrc|stylelintrc)$'

# .env files — always route through trace-mcp to prevent secret leakage
ENV_FILE_RE='\.env(\.[a-zA-Z0-9._-]+)?$'

# Safe bash command prefixes — never block
SAFE_BASH_RE='^(git |npm |npx |pnpm |yarn |bun |node |deno |cargo |go |make |mvn |gradle |docker |kubectl |helm |terraform |pip |poetry |uv |pytest |vitest |jest |phpunit |composer |artisan |rails |bundle |mix |dotnet |cmake |ninja |meson )'

# Cross-platform sha256 hash (Linux: sha256sum, macOS: shasum)
file_sha256() {
  echo -n "$1" | sha256sum 2>/dev/null | cut -d' ' -f1 || echo -n "$1" | shasum -a 256 2>/dev/null | cut -d' ' -f1
}

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

# Consultation markers: trace-mcp server writes these when get_outline/get_symbol/etc. are called.
# If a file was already consulted via trace-mcp, allow Read immediately (agent needs full content for Edit).
# Dir format: $TMPDIR/trace-mcp-consulted-{sha256(projectRoot)[:12]}/{sha256(relPath)}
PROJECT_ROOT="$(pwd)"
if command -v sha256sum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | sha256sum | cut -c1-12)
elif command -v shasum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
else
  PROJECT_HASH=""
fi
CONSULTED_DIR="${TMPDIR:-/tmp}/trace-mcp-consulted-${PROJECT_HASH}"

# Repeat-read tracker dir (v0.6.0): per-session state of allowed reads per file.
# Format: one file per read target, contents = "count:mtime"
READS_DIR="${TMPDIR:-/tmp}/trace-mcp-reads-${SESSION_ID}"
mkdir -p "$READS_DIR" 2>/dev/null || true

# Max allowed reads of an unchanged code file before forcing get_symbol/get_outline.
REPEAT_READ_LIMIT=2

# Portable mtime (macOS / Linux).
file_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# --- Read ---
if [[ "$TOOL_NAME" == "Read" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

  # Block .env files — prevent secret leakage to AI model context
  if echo "$FILE_PATH" | grep -qiE "$ENV_FILE_RE"; then
    REL_PATH=$(echo "$FILE_PATH" | sed "s|^$(pwd)/||")
    deny \
      "Use get_env_vars for .env files — it masks sensitive values (passwords, API keys, tokens)." \
      "trace-mcp alternatives for ${REL_PATH}:\\n- get_env_vars { \\\"file\\\": \\\"${REL_PATH}\\\" } — list keys + types without exposing secrets\\n- get_env_vars { \\\"pattern\\\": \\\"DB_\\\" } — filter by key prefix\\nNever read .env files directly — secrets will leak into AI model context."
  fi

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
    # --- Repeat-read dedup (v0.6.0) ---
    # Track allowed reads per file per session. Reset on mtime change (post-Edit).
    FILE_HASH=$(file_sha256 "$FILE_PATH")
    READ_STATE="$READS_DIR/$FILE_HASH"
    PREV_COUNT=0
    PREV_MTIME=""
    HAD_STATE=0
    if [[ -f "$READ_STATE" ]]; then
      IFS=':' read -r PREV_COUNT PREV_MTIME < "$READ_STATE" || true
      PREV_COUNT="${PREV_COUNT:-0}"
      HAD_STATE=1
    fi
    CUR_MTIME=$(file_mtime "$FILE_PATH")
    # Reset count if file was modified since last allowed read (Edit/Write happened).
    # HAD_STATE stays 1 so we skip the first-time deny-marker friction below.
    if [[ "$CUR_MTIME" != "$PREV_MTIME" ]]; then
      PREV_COUNT=0
    fi

    # Already hit the limit on an unchanged file — force trace-mcp narrow lookups.
    if (( PREV_COUNT >= REPEAT_READ_LIMIT )); then
      REL_PATH=$(echo "$FILE_PATH" | sed "s|^${PROJECT_ROOT}/||")
      deny \
        "Already read ${REL_PATH} ${PREV_COUNT}x this session — use get_symbol/get_outline instead of re-reading." \
        "trace-mcp alternatives for ${REL_PATH}:\\n- get_symbol { \\\"fqn\\\": \\\"SymbolName\\\" } — read ONE symbol instead of the whole file\\n- get_outline { \\\"path\\\": \\\"${REL_PATH}\\\" } — signatures only (much cheaper than full reads)\\n- get_context_bundle { \\\"symbol_id\\\": \\\"...\\\" } — symbol + its imports in one call\\n- get_feature_context { \\\"description\\\": \\\"what you need\\\" } — NL query over the indexed codebase\\nThe counter resets automatically if you Edit/Write this file."
    fi

    # Compute relative path for consultation marker check (server writes markers keyed by relative path)
    REL_PATH_FOR_HASH=$(echo "$FILE_PATH" | sed "s|^${PROJECT_ROOT}/||")
    CONSULTED_HASH=$(file_sha256 "$REL_PATH_FOR_HASH")

    # Check if file was already consulted via trace-mcp (get_outline, get_symbol, etc.)
    if [[ -n "$PROJECT_HASH" && -f "$CONSULTED_DIR/$CONSULTED_HASH" ]]; then
      # File was consulted via trace-mcp → allow Read (agent needs full content for Edit)
      echo "$((PREV_COUNT + 1)):${CUR_MTIME}" > "$READ_STATE"
      exit 0
    fi

    # If we already tracked this file this session (HAD_STATE=1), skip the
    # first-time deny-marker cycle — the agent already "earned" the right to
    # read it. This covers both: (a) mid-session re-reads, and (b) post-Edit
    # re-reads where count was reset by mtime change.
    if (( HAD_STATE == 1 )); then
      echo "$((PREV_COUNT + 1)):${CUR_MTIME}" > "$READ_STATE"
      exit 0
    fi

    # First-time read of this file: deny on attempt #1, allow on retry.
    DENY_MARKER="$DENY_DIR/$FILE_HASH"
    if [[ -f "$DENY_MARKER" ]]; then
      rm -f "$DENY_MARKER"
      echo "1:${CUR_MTIME}" > "$READ_STATE"
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

  # Block grep on .env files — prevent secret leakage
  if echo "$GREP_GLOB" | grep -qiE '\.env' || echo "$GREP_PATH" | grep -qiE "$ENV_FILE_RE"; then
    deny \
      "Use get_env_vars for .env files — it masks sensitive values." \
      "trace-mcp alternatives:\\n- get_env_vars { \\\"pattern\\\": \\\"search_term\\\" } — find env vars by key pattern without exposing values"
  fi

  # Allow grep on non-code file types
  if echo "$GREP_GLOB" | grep -qiE '\.(md|json|ya?ml|toml|txt|html|xml|csv|cfg|ini|lock|log)'; then
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

  # Block glob on .env patterns
  if echo "$GLOB_PATTERN" | grep -qiE '\.env'; then
    deny \
      "Use get_env_vars for .env files — it masks sensitive values." \
      "trace-mcp alternatives:\\n- get_env_vars {} — list all env vars across all .env files"
  fi

  # Allow glob for non-code patterns
  if echo "$GLOB_PATTERN" | grep -qiE '\.(md|json|ya?ml|toml|txt|html|xml|csv|cfg|ini|lock|log)'; then
    exit 0
  fi

  deny \
    "Use trace-mcp for code file discovery — it knows your project structure." \
    "trace-mcp alternatives:\\n- get_project_map { \\\"summary_only\\\": true } — project overview (frameworks, languages, structure)\\n- search { \\\"query\\\": \\\"keyword\\\", \\\"file_pattern\\\": \\\"src/tools/*\\\" } — find symbols in specific paths\\n- get_outline { \\\"path\\\": \\\"path/to/file\\\" } — see what is in a file\\nUse Glob only for non-code file patterns."

fi

# --- Bash ---
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

  # Allow safe commands
  if echo "$COMMAND" | grep -qE "$SAFE_BASH_RE"; then
    exit 0
  fi

  # Block bash commands targeting .env files — prevent secret leakage
  if echo "$COMMAND" | grep -qiE "$ENV_FILE_RE"; then
    deny \
      "Use get_env_vars for .env files — it masks sensitive values (passwords, API keys, tokens)." \
      "trace-mcp alternatives:\\n- get_env_vars {} — list all env vars across all .env files\\n- get_env_vars { \\\"pattern\\\": \\\"DB_\\\" } — filter by key prefix\\nNever access .env files via shell — secrets will leak into AI model context."
  fi

  # Block code exploration via bash (grep, find, cat, head, tail on code files)
  if echo "$COMMAND" | grep -qE '(^|\|)\s*(grep|rg|find|cat|head|tail|less|more|awk|sed)\s' && echo "$COMMAND" | grep -qiE "$CODE_EXT_RE"; then
    deny \
      "Use trace-mcp instead of shell commands for code exploration." \
      "trace-mcp has structured tools for this:\\n- search — find symbols by name\\n- get_symbol — read a specific symbol\\n- get_outline — file structure\\n- find_usages — all usages of a symbol\\nUse Bash only for builds, tests, git, and system commands."
  fi

  exit 0
fi

# --- Agent ---
# Block Agent(Explore) and exploration-style Agent(general-purpose).
# Each Agent subprocess costs ~50K tokens overhead (system prompt + CLAUDE.md + memory).
# trace-mcp tools (get_task_context, get_feature_context, batch) do the same for ~4K tokens.
if [[ "$TOOL_NAME" == "Agent" ]]; then
  SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general-purpose"')
  DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // ""' | tr '[:upper:]' '[:lower:]')

  # Always block Explore agents — trace-mcp replaces them entirely
  if [[ "$SUBAGENT_TYPE" == "Explore" ]]; then
    deny \
      "Agent(Explore) wastes ~50K tokens on overhead. Use trace-mcp tools instead (~4K tokens)." \
      "trace-mcp alternatives:\\n- get_task_context { \\\"task\\\": \\\"your exploration goal\\\" } — focused context in one call\\n- get_feature_context { \\\"description\\\": \\\"what you need\\\" } — NL query → relevant symbols\\n- batch with multiple search/get_outline/get_symbol calls — parallel lookups\\n- get_project_map { \\\"summary_only\\\": true } — project overview"
  fi

  # Block general-purpose agents doing code exploration (not coding/testing/research)
  if [[ "$SUBAGENT_TYPE" == "general-purpose" ]]; then
    EXPLORE_RE='(explore|investigate|understand|analyz|analys|audit|study|deep dive|catalog|inspect|trace|walk ?through|summari[sz]e|identify|discover|locate|document .* (code|module|function|class|registry|package|file|project|handler|service|component|plugin|api|middleware|hook|schema)|review .* (code|module|file|implementation)|check .* (code|structure|architecture|implementation|pattern)|find .* (code|pattern|usage|definition|references?|callers?)|map .* (dependencies|imports|structure|flow)|list .* (files|symbols|classes|functions|modules)|how .* (work|implemented)|where .* (defined|used|called))'
    if echo "$DESCRIPTION" | grep -qiE "$EXPLORE_RE"; then
      deny \
        "Agent(general-purpose) for code exploration wastes ~50K tokens. Use trace-mcp tools instead." \
        "trace-mcp alternatives:\\n- get_task_context { \\\"task\\\": \\\"${DESCRIPTION}\\\" } — replaces exploration agents (~4K tokens)\\n- get_feature_context { \\\"description\\\": \\\"...\\\" } — NL query → relevant code\\n- find_usages / get_call_graph / get_change_impact — relationship analysis\\n- batch { \\\"calls\\\": [...] } — multiple lookups in one call\\nAgent is OK for: writing code, running tests, web research, Plan mode."
    fi
  fi

  exit 0
fi

# Allow everything else
exit 0
