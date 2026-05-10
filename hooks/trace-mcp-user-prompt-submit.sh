#!/usr/bin/env bash
# trace-mcp-user-prompt-submit v0.1.0
# trace-mcp UserPromptSubmit hook
#
# On each user prompt, runs a fast FTS5 query against the decision memory
# (top-K=3) using the prompt as the search string and injects the matching
# decisions as additionalContext so the agent sees them BEFORE processing.
#
# Output schema (Claude Code UserPromptSubmit):
#   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
#                             "additionalContext": "<text>" } }
#
# Soft budget: ~10s. Degrades silently on any failure (timeout, missing CLI,
# empty result, missing daemon) — the hook MUST NEVER block the user prompt.
#
# Install: add to ~/.claude/settings.json under UserPromptSubmit
# See README.md for setup instructions.

set -uo pipefail

INPUT=$(cat 2>/dev/null || true)

# Per-user opt-out without uninstalling.
if [[ "${TRACE_MCP_USER_PROMPT_OFF:-0}" == "1" ]]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // .user_prompt // .input // empty' 2>/dev/null)
if [[ -z "$PROMPT" ]]; then
  exit 0
fi

# Truncate the prompt to a sane FTS5 query size (the search column accepts up
# to 500 chars). Strip newlines to keep FTS5 happy.
QUERY=$(printf '%s' "$PROMPT" | tr '\n' ' ' | cut -c1-200)
if [[ -z "$QUERY" ]]; then
  exit 0
fi

PROJECT_ROOT="$(pwd)"

if command -v trace-mcp >/dev/null 2>&1; then
  TRACE_MCP_BIN=trace-mcp
elif [[ -x "$HOME/.trace-mcp/bin/trace-mcp" ]]; then
  TRACE_MCP_BIN="$HOME/.trace-mcp/bin/trace-mcp"
else
  exit 0
fi

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 10s "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 10s "$@"
  else
    "$@"
  fi
}

DECISIONS_JSON=$(run_with_timeout "$TRACE_MCP_BIN" memory decisions \
  --project "$PROJECT_ROOT" \
  --search "$QUERY" \
  --limit 3 \
  --json 2>/dev/null) || exit 0

# Empty array OR empty string → nothing to inject.
if [[ -z "$DECISIONS_JSON" ]] || [[ "$DECISIONS_JSON" == "[]" ]]; then
  exit 0
fi

COUNT=$(printf '%s' "$DECISIONS_JSON" | jq 'length' 2>/dev/null || echo 0)
if [[ "$COUNT" == "0" ]]; then
  exit 0
fi

CONTEXT=$(printf '%s' "$DECISIONS_JSON" | jq -r '
  def truncate($n): if (. | length) > $n then .[0:$n] + "..." else . end;
  [
    "[trace-mcp memory] " + (length | tostring) + " relevant decision(s) for your prompt:",
    (
      .[] | "  - #" + (.id | tostring) + " [" + .type + "] " + (.title | truncate(100))
        + "\n    " + ((.content // "") | truncate(240))
        + ( if .symbol_id then "\n    → " + .symbol_id
            else if .file_path then "\n    → " + .file_path else "" end end )
    ),
    "If any of these contradict the request, surface the conflict before acting."
  ] | join("\n")
' 2>/dev/null) || exit 0

if [[ -z "$CONTEXT" ]]; then
  exit 0
fi

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'

exit 0
