#!/usr/bin/env bash
# trace-mcp-worktree v0.2.0
# trace-mcp WorktreeCreate / WorktreeRemove hook
#
# WorktreeCreate: ensures the *main* repo's index is ready, then exits.
#   The serve command automatically detects the worktree and shares the main
#   repo's DB — no separate full re-index needed.
#
# WorktreeRemove: no-op.  The main repo's DB is unaffected.
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
  WORKTREE_PATH=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
fi

if [[ -z "$WORKTREE_PATH" ]]; then
  exit 0
fi

# Resolve to absolute path
WORKTREE_PATH=$(cd "$WORKTREE_PATH" 2>/dev/null && pwd || echo "$WORKTREE_PATH")

case "$EVENT" in
  WorktreeCreate|worktree_create|create)
    # Resolve the main repo root from the worktree's .git file.
    # A linked worktree has .git as a file: "gitdir: /main/.git/worktrees/<name>"
    GIT_FILE="$WORKTREE_PATH/.git"
    MAIN_ROOT=""

    if [[ -f "$GIT_FILE" ]]; then
      GITDIR_LINE=$(grep '^gitdir:' "$GIT_FILE" 2>/dev/null || true)
      if [[ -n "$GITDIR_LINE" ]]; then
        ADMIN_DIR="${GITDIR_LINE#gitdir: }"
        # Make absolute if relative
        if [[ "$ADMIN_DIR" != /* ]]; then
          ADMIN_DIR="$WORKTREE_PATH/$ADMIN_DIR"
        fi
        # commondir points (relative to admin dir) to the main .git dir
        if [[ -f "$ADMIN_DIR/commondir" ]]; then
          COMMONDIR=$(cat "$ADMIN_DIR/commondir")
          if [[ "$COMMONDIR" != /* ]]; then
            COMMONDIR="$ADMIN_DIR/$COMMONDIR"
          fi
          # Resolve symlinks / relative components
          MAIN_GIT=$(cd "$COMMONDIR" 2>/dev/null && pwd || echo "")
          if [[ -d "$MAIN_GIT" ]]; then
            MAIN_ROOT=$(dirname "$MAIN_GIT")
          fi
        fi
      fi
    fi

    # Fallback: try git rev-parse from the worktree dir itself
    if [[ -z "$MAIN_ROOT" ]]; then
      COMMON=$(cd "$WORKTREE_PATH" && git rev-parse --git-common-dir 2>/dev/null || true)
      if [[ -n "$COMMON" ]]; then
        if [[ "$COMMON" != /* ]]; then
          COMMON="$WORKTREE_PATH/$COMMON"
        fi
        MAIN_GIT=$(cd "$COMMON" 2>/dev/null && pwd || echo "")
        if [[ -d "$MAIN_GIT" ]]; then
          MAIN_ROOT=$(dirname "$MAIN_GIT")
        fi
      fi
    fi

    if [[ -z "$MAIN_ROOT" ]]; then
      # Can't determine main root — fall back to indexing the worktree itself
      nohup trace-mcp add "$WORKTREE_PATH" --force --json >/dev/null 2>&1 &
      exit 0
    fi

    # Check whether the main repo is already registered and indexed
    REGISTRY="$HOME/.trace-mcp/registry.json"
    NEEDS_INDEX=true
    if [[ -f "$REGISTRY" ]]; then
      LAST_INDEXED=$(jq -r --arg r "$MAIN_ROOT" '.projects[$r].lastIndexed // empty' "$REGISTRY" 2>/dev/null || true)
      if [[ -n "$LAST_INDEXED" && "$LAST_INDEXED" != "null" ]]; then
        NEEDS_INDEX=false
      fi
    fi

    if [[ "$NEEDS_INDEX" == "true" ]]; then
      # Main repo not yet indexed — index it in the background
      nohup trace-mcp add "$MAIN_ROOT" --json >/dev/null 2>&1 &
    fi
    # else: main repo already indexed; serve will share its DB automatically
    ;;

  WorktreeRemove|worktree_remove|remove)
    # The main repo's DB is shared — do not delete it.
    # Nothing to clean up.
    ;;
esac

exit 0
