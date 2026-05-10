#!/usr/bin/env bash
# trace-mcp-stop v0.1.0
# trace-mcp Stop hook
#
# After the agent stops, mines newly produced session logs in the background
# so newly emitted decisions land in the index without manual invocation.
#
# Async by design: the foreground process exits within milliseconds. The mine
# runs in a detached `nohup ... &` subshell so the agent's turn completion is
# never blocked. Soft budget ~180s for the background work itself.
#
# Install: add to ~/.claude/settings.json under Stop
# See README.md for setup instructions.

set -uo pipefail

# Per-user opt-out without uninstalling.
if [[ "${TRACE_MCP_STOP_OFF:-0}" == "1" ]]; then
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

# Single-flight guard: if a mine for this project is already running, skip.
# Project hash matches the launcher / guard hashing scheme (sha256, 12 hex).
if command -v sha256sum >/dev/null 2>&1; then
  PROJECT_HASH=$(printf '%s' "$PROJECT_ROOT" | sha256sum | cut -c1-12)
elif command -v shasum >/dev/null 2>&1; then
  PROJECT_HASH=$(printf '%s' "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
else
  PROJECT_HASH=""
fi

LOCK_FILE="${TMPDIR:-/tmp}/trace-mcp-stop-mining-${PROJECT_HASH}.pid"
if [[ -n "$PROJECT_HASH" && -f "$LOCK_FILE" ]]; then
  EXISTING_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    # Another mine still running — skip this turn's mine.
    exit 0
  fi
  rm -f "$LOCK_FILE" 2>/dev/null || true
fi

LOG_FILE="${TMPDIR:-/tmp}/trace-mcp-stop-mining-${PROJECT_HASH}.log"

# Fire-and-forget: detach via nohup + &, redirect everything to log file.
# The background subshell writes its own PID to the lock file before invoking
# the miner so a second Stop within the mining window short-circuits cleanly.
(
  echo "$BASHPID" > "$LOCK_FILE" 2>/dev/null || true
  nohup "$TRACE_MCP_BIN" memory mine \
    --project "$PROJECT_ROOT" \
    >"$LOG_FILE" 2>&1
  rm -f "$LOCK_FILE" 2>/dev/null || true
) >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
