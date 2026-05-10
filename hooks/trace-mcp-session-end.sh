#!/usr/bin/env bash
# trace-mcp-session-end v0.1.0
# trace-mcp SessionEnd hook
#
# Lightweight cleanup at session end: removes per-session guard state for THIS
# session (so the tmpdir doesn't accumulate `trace-mcp-reads-<sid>/` directories
# between session ends and the precompact's 24h GC sweep) and touches a journal
# sentinel so downstream tools can detect "session ended cleanly".
#
# Soft budget: ~5s. Never blocks; degrades silently.
#
# Install: add to ~/.claude/settings.json under SessionEnd
# See README.md for setup instructions.

set -uo pipefail

if [[ "${TRACE_MCP_SESSION_END_OFF:-0}" == "1" ]]; then
  exit 0
fi

INPUT=$(cat 2>/dev/null || true)

SESSION_ID=""
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
fi

PROJECT_ROOT="$(pwd)"

# Cleanup per-session guard state dir for THIS session, if any. The guard hook
# allocates `${TMPDIR:-/tmp}/trace-mcp-reads-${SESSION_ID}/` lazily; removing
# it here is purely advisory (the precompact hook GCs ones older than 24h).
if [[ -n "$SESSION_ID" ]]; then
  READS_DIR="${TMPDIR:-/tmp}/trace-mcp-reads-${SESSION_ID}"
  if [[ -d "$READS_DIR" ]]; then
    rm -rf "$READS_DIR" 2>/dev/null || true
  fi
fi

# Journal flush: append a session-end marker so downstream tools (analytics,
# session-resume) know the session ended cleanly rather than crashed.
if command -v sha256sum >/dev/null 2>&1; then
  PROJECT_HASH=$(printf '%s' "$PROJECT_ROOT" | sha256sum | cut -c1-12)
elif command -v shasum >/dev/null 2>&1; then
  PROJECT_HASH=$(printf '%s' "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
else
  PROJECT_HASH=""
fi

if [[ -n "$PROJECT_HASH" ]]; then
  JOURNAL_DIR="$HOME/.trace-mcp/sessions"
  mkdir -p "$JOURNAL_DIR" 2>/dev/null || true
  JOURNAL_FILE="$JOURNAL_DIR/${PROJECT_HASH}-end.log"
  if command -v date >/dev/null 2>&1; then
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
    printf '%s\t%s\n' "$TS" "${SESSION_ID:-unknown}" >> "$JOURNAL_FILE" 2>/dev/null || true
  fi
fi

exit 0
