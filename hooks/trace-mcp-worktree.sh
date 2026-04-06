#!/usr/bin/env bash
# trace-mcp-worktree v0.1.0
# trace-mcp WorktreeCreate / WorktreeRemove hook
# On WorktreeCreate: registers and indexes the new worktree so trace-mcp tools work immediately.
# On WorktreeRemove: deregisters the worktree project from the registry.
#
# Install: add to ~/.claude/settings.json or .claude/settings.local.json
# See README.md for setup instructions.

set -euo pipefail

INPUT=$(cat)

# Claude Code passes the event type via CLAUDE_HOOK_EVENT or hook_event_name
EVENT="${CLAUDE_HOOK_EVENT:-}"
if [[ -z "$EVENT" ]]; then
  EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // .event // empty' 2>/dev/null)
fi

# Extract worktree path from hook input
WORKTREE_PATH=$(echo "$INPUT" | jq -r '.tool_input.path // .worktree_path // .path // empty' 2>/dev/null)

if [[ -z "$WORKTREE_PATH" ]]; then
  # Fallback: use working directory from input
  WORKTREE_PATH=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
fi

if [[ -z "$WORKTREE_PATH" ]]; then
  exit 0
fi

# Resolve to absolute path
WORKTREE_PATH=$(cd "$WORKTREE_PATH" 2>/dev/null && pwd || echo "$WORKTREE_PATH")

case "$EVENT" in
  WorktreeCreate|worktree_create|create)
    # Register and index the new worktree in the background
    # --force: re-register even if parent repo is already known (worktree is a different root)
    nohup trace-mcp add "$WORKTREE_PATH" --force --json >/dev/null 2>&1 &
    ;;
  WorktreeRemove|worktree_remove|remove)
    # Clean up the worktree DB file if it exists.
    # The global registry entry becomes stale but is harmless — next `trace-mcp add` overwrites it.
    PROJECT_HASH=""
    if command -v sha256sum >/dev/null 2>&1; then
      PROJECT_HASH=$(echo -n "$WORKTREE_PATH" | sha256sum | cut -c1-12)
    elif command -v shasum >/dev/null 2>&1; then
      PROJECT_HASH=$(echo -n "$WORKTREE_PATH" | shasum -a 256 | cut -c1-12)
    fi
    if [[ -n "$PROJECT_HASH" ]]; then
      DB_FILE="$HOME/.trace-mcp/db/${PROJECT_HASH}.db"
      rm -f "$DB_FILE" "$DB_FILE-shm" "$DB_FILE-wal" 2>/dev/null
    fi
    ;;
esac

exit 0
