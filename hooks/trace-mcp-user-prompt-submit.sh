#!/usr/bin/env bash
# trace-mcp-user-prompt-submit v0.3.0
# trace-mcp UserPromptSubmit hook
#
# Two jobs, in this order:
#
#   1. Guard v2 routing signal (TRA-711). Each new user prompt starts a new
#      navigation streak, so the counter the PreToolUse guard keeps is reset
#      here. The prompt is also matched against relationship-question shapes
#      ("who calls X", "what breaks if I change Y", "which tests cover Z") —
#      the shape where TRA-705 measured trace-mcp winning. A match writes a
#      flag that makes the guard route from the FIRST navigation call instead
#      of waiting for the third. This runs before anything that can fail, so a
#      missing CLI or daemon never costs us the signal.
#
#   2. Decision-memory injection (below). On each user prompt, runs a fast FTS5
#      query against the decision memory
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

# ─── Guard v2 routing signal (TRA-711) ─────────────────────────────
# Shares the guard's per-session state directory verbatim; keep the path
# construction in sync with hooks/trace-mcp-guard.sh.
UPS_SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "default"' 2>/dev/null)
UPS_READS_DIR="${TMPDIR:-/tmp}/trace-mcp-reads-${UPS_SESSION_ID:-default}"
mkdir -p "$UPS_READS_DIR" 2>/dev/null || true

# A new prompt is a new question: the previous navigation streak should not
# make the guard intervene on the first call of an unrelated light one.
rm -f "$UPS_READS_DIR/.nav-streak" 2>/dev/null || true

# Relationship-question shapes. These are the queries TRA-705 measured
# trace-mcp winning on (call graph / blast radius / test coverage), so they
# skip the streak gate and get routed from the first navigation call. The
# Russian alternatives are here because this matches user input, not because
# it is user-visible text.
UPS_NAV_FORCE_RE='(who (calls|uses|invokes|imports)|call(ers|ed by|[- ]graph)|what (breaks|will break|would break)|blast radius|impact of (changing|renaming|removing)|affected by|safe to (change|rename|delete|remove)|(which|what) tests|tests? (cover|covering|for)|test coverage (for|of)|all (usages|references|callers|dependents)|where is .* used|depends on this|reverse dependenc)'
UPS_NAV_FORCE_RE_RU='(кто (вызывает|использует|импортирует)|что сломается|что затрон|на что повлия|какие тесты|где используется|кто зависит|все (вызовы|использования|места использования))'

if printf '%s' "$PROMPT" | grep -qiE "$UPS_NAV_FORCE_RE" \
   || printf '%s' "$PROMPT" | grep -qiE "$UPS_NAV_FORCE_RE_RU"; then
  : > "$UPS_READS_DIR/.nav-force" 2>/dev/null || true
else
  rm -f "$UPS_READS_DIR/.nav-force" 2>/dev/null || true
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
