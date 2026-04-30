#!/usr/bin/env bash
# Manually disable the trace-mcp PreToolUse guard for the current project.
#
# Writes a bypass sentinel to $TMPDIR/trace-mcp-bypass-{projectHash} whose
# mtime is set N minutes into the future. The guard hook treats the sentinel
# as valid until its mtime is reached, then ignores it (TTL).
#
# Usage:
#   bash scripts/trace-mcp-disable-guard.sh           # default 10 minutes
#   bash scripts/trace-mcp-disable-guard.sh 30        # 30 minutes
#   bash scripts/trace-mcp-disable-guard.sh 0         # remove (re-enable)
#
# Why: when the MCP channel is unstable (e.g. "Session not found") but the
# trace-mcp process is still alive, the heartbeat sentinel is fresh and the
# hook stays strict. This script lets the user (or the agent on the user's
# explicit request) flip the hook to degraded mode without restarting the
# server or editing settings.

set -euo pipefail

MINUTES="${1:-10}"

if ! [[ "$MINUTES" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 [minutes]" >&2
  exit 1
fi

PROJECT_ROOT="$(pwd)"
if command -v sha256sum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | sha256sum | cut -c1-12)
elif command -v shasum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
else
  echo "error: neither sha256sum nor shasum found" >&2
  exit 1
fi

BYPASS_FILE="${TMPDIR:-/tmp}/trace-mcp-bypass-${PROJECT_HASH}"

if [[ "$MINUTES" -eq 0 ]]; then
  rm -f "$BYPASS_FILE"
  echo "trace-mcp guard re-enabled for: $PROJECT_ROOT"
  exit 0
fi

# Write the sentinel with mtime = now + MINUTES*60 seconds.
echo "trace-mcp-bypass" > "$BYPASS_FILE"
EXPIRY=$(( $(date +%s) + MINUTES * 60 ))
if touch -t "$(date -r "$EXPIRY" +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$EXPIRY" +%Y%m%d%H%M.%S)" "$BYPASS_FILE" 2>/dev/null; then
  :
else
  # Fallback: BSD `touch -d @epoch` (macOS supports it via -t with formatted date)
  touch -d "@$EXPIRY" "$BYPASS_FILE" 2>/dev/null || true
fi

EXPIRY_HUMAN=$(date -r "$EXPIRY" 2>/dev/null || date -d "@$EXPIRY" 2>/dev/null || echo "+${MINUTES} min")
echo "trace-mcp guard DISABLED for ${MINUTES} minute(s) — until $EXPIRY_HUMAN"
echo "project: $PROJECT_ROOT"
echo "sentinel: $BYPASS_FILE"
echo "Re-enable early: bash $(basename "$0") 0"
