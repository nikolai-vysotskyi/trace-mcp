#!/usr/bin/env bash
# trace-mcp-precompact v0.1.0
# trace-mcp PreCompact hook
# Injects session snapshot into compacted context to prevent "compaction amnesia".
# Reads the live snapshot file written by the running trace-mcp MCP server and
# returns it via the systemMessage field in Claude Code's hook output schema.
#
# Install: add to ~/.claude/settings.json or .claude/settings.local.json under PreCompact
# See README.md for setup instructions.

set -euo pipefail

# Determine project root from working directory
PROJECT_ROOT="$(pwd)"

# Compute project hash (same algorithm as trace-mcp: sha256, first 12 hex chars)
if command -v sha256sum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | sha256sum | cut -c1-12)
elif command -v shasum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
else
  # Fallback: no hash available, exit silently
  exit 0
fi

SNAPSHOT_FILE="$HOME/.trace-mcp/sessions/${PROJECT_HASH}-snapshot.json"

# If no snapshot file exists, exit silently (no session data yet)
if [[ ! -f "$SNAPSHOT_FILE" ]]; then
  exit 0
fi

# Check file freshness — skip if older than 10 minutes (stale session)
if command -v stat >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" ]]; then
    FILE_MTIME=$(stat -f %m "$SNAPSHOT_FILE" 2>/dev/null || echo 0)
  else
    FILE_MTIME=$(stat -c %Y "$SNAPSHOT_FILE" 2>/dev/null || echo 0)
  fi
  NOW=$(date +%s)
  AGE=$(( NOW - FILE_MTIME ))
  if [[ $AGE -gt 600 ]]; then
    exit 0
  fi
fi

# Read the markdown snapshot from the JSON file
MARKDOWN=$(jq -r '.markdown // empty' "$SNAPSHOT_FILE" 2>/dev/null)

if [[ -z "$MARKDOWN" ]]; then
  exit 0
fi

# Output systemMessage for Claude Code to inject into compacted context
jq -n --arg msg "$MARKDOWN" '{ "systemMessage": $msg }'

exit 0
