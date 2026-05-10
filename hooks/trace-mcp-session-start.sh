#!/usr/bin/env bash
# trace-mcp-session-start v0.1.0
# trace-mcp SessionStart hook
#
# Injects a compact wake-up context (~300 tokens) at session start so the agent
# starts each conversation oriented toward the project's decisions and memory
# stats. Mirrors MemPalace's "memoir on wake" pattern, but code-aware.
#
# Output schema (Claude Code SessionStart):
#   { "hookSpecificOutput": { "hookEventName": "SessionStart",
#                             "additionalContext": "<text>" } }
#
# Soft budget: ~15s. Degrades silently on any failure — the hook MUST NEVER
# block the agent from starting.
#
# Install: add to ~/.claude/settings.json under SessionStart
# See README.md for setup instructions.

set -uo pipefail

# Read stdin (Claude Code passes a JSON envelope) — discard, we only need cwd.
INPUT=$(cat 2>/dev/null || true)

# Per-user opt-out without uninstalling.
if [[ "${TRACE_MCP_SESSION_START_OFF:-0}" == "1" ]]; then
  exit 0
fi

PROJECT_ROOT="$(pwd)"

# Locate the trace-mcp CLI. Prefer PATH, fall back to launcher shim if present.
if command -v trace-mcp >/dev/null 2>&1; then
  TRACE_MCP_BIN=trace-mcp
elif [[ -x "$HOME/.trace-mcp/bin/trace-mcp" ]]; then
  TRACE_MCP_BIN="$HOME/.trace-mcp/bin/trace-mcp"
else
  exit 0
fi

# Soft timeout: 15s budget. `timeout` is GNU coreutils on Linux; on macOS it
# may be missing — try gtimeout, then fall back to running without a hard cap
# (the wake-up CLI is read-only and bounded by SQLite query latency).
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 15s "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 15s "$@"
  else
    "$@"
  fi
}

WAKE_JSON=$(run_with_timeout "$TRACE_MCP_BIN" memory wake-up \
  --project "$PROJECT_ROOT" --json 2>/dev/null) || exit 0

if [[ -z "$WAKE_JSON" ]]; then
  exit 0
fi

# Build a compact human-readable orientation block from the JSON.
# Falls back to raw JSON if jq is missing.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$WAKE_JSON" | head -c 4000
  exit 0
fi

CONTEXT=$(printf '%s' "$WAKE_JSON" | jq -r '
  def truncate($n): if (. | length) > $n then .[0:$n] + "..." else . end;
  def safe(s): s // "(unknown)";
  [
    "[trace-mcp wake-up]",
    "Project: " + safe(.project.name) + " (" + safe(.project.root) + ")",
    "Decisions: " + ((.decisions.total_active // 0) | tostring) + " active",
    (
      if ((.decisions.recent // []) | length) > 0 then
        "Recent decisions:"
      else
        "No recent decisions yet — run `trace-mcp memory mine` to extract from session logs."
      end
    ),
    (
      (.decisions.recent // [])[:5] | map(
        "  - #" + (.id | tostring) + " [" + .type + "] " + (.title | truncate(80))
        + ( if .symbol then " → " + .symbol else if .file then " → " + .file else "" end end )
      )[]
    ),
    "Memory: " + ((.memory.sessions_mined // 0) | tostring) + " sessions mined, "
      + ((.memory.sessions_indexed // 0) | tostring) + " indexed, "
      + ((.memory.total_decisions // 0) | tostring) + " total decisions",
    "Tip: call get_wake_up / query_decisions for richer context."
  ] | join("\n")
' 2>/dev/null) || exit 0

if [[ -z "$CONTEXT" ]]; then
  exit 0
fi

# Emit as additionalContext under the SessionStart hook envelope.
jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'

exit 0
